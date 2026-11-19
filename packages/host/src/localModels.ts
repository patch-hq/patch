// Local models (docs/providers.md § Proposed suite): an Ollama, llama.cpp or
// LM Studio server reached through its OpenAI-compatible endpoint, served by
// the generic OpenAI-compatible engine. The endpoint is account-wide shared
// setting (`localModelBaseUrl`); the models on offer are whatever the
// endpoint itself lists. Nothing here calls a paid API, and there is no
// fallback: an unset or unreachable endpoint is an error that says so.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { providerDescriptor } from '@patch/wire';
import type { DurableTurnRequest } from './durableTurn.js';
import { keepRunnerLog, retireTurn, turnDirFor } from './durableTurn.js';
import type { SdkBackend, SdkEnvelope, SdkRunOptions } from './sdkBackend.js';
import { CodexHistory } from './codexHistory.js';
import { DurableCodexProcess } from './codexDurable.js';
import type { LocalAgentFailure, LocalAgentStart } from './localAgent.js';
import {
  OpenAICompatBackend,
  OpenAICompatError,
  openaiCompatPermission,
} from './openaiCompatBackend.js';
import { RUNNER_OUT } from './turnRunner.js';

const LOCAL = providerDescriptor('local');
const LOCAL_MODEL_PREFIX = LOCAL.modelPrefix!;
export const LOCAL_BACKEND_ID = LOCAL.backendId;
export const isLocalModel = (model?: string): boolean =>
  model?.startsWith(LOCAL_MODEL_PREFIX) === true;

export class LocalEndpointError extends Error {
  override readonly name = 'LocalEndpointError';
}

export class LocalModels {
  private baseUrl: string | undefined;
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  /** Apply the shared setting; absent or empty means not configured. */
  setBaseUrl(url: string | undefined): void {
    this.baseUrl = url?.trim() ? url.trim().replace(/\/+$/, '') : undefined;
  }

  get configured(): boolean {
    return this.baseUrl !== undefined;
  }

  private requireBaseUrl(): string {
    if (!this.baseUrl)
      throw new LocalEndpointError(
        'No local model endpoint is set. Add its URL under Settings → Providers → Local model.',
      );
    return this.baseUrl;
  }

  /** The endpoint and model name a `local/<name>` chat talks to. */
  resolveEndpoint(model: string | undefined): { baseUrl: string; model: string } {
    if (!isLocalModel(model)) throw new Error(`${model ?? 'No model'} is not a local model`);
    return { baseUrl: this.requireBaseUrl(), model: model!.slice(LOCAL_MODEL_PREFIX.length) };
  }

  /** What the endpoint lists, as `local/<name>` entries. */
  async models(): Promise<Array<{ id: string; label: string }>> {
    const baseUrl = this.requireBaseUrl();
    let res: Response;
    try {
      res = await this.fetchImpl(`${baseUrl}/models`, { signal: AbortSignal.timeout(5000) });
    } catch (e) {
      throw new LocalEndpointError(
        `Cannot reach the local model endpoint ${baseUrl}: ${(e as Error).message}`,
      );
    }
    if (!res.ok) throw new LocalEndpointError(`${baseUrl}/models answered ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(body.data))
      throw new LocalEndpointError(`${baseUrl}/models did not return a model list`);
    return body.data
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id !== '')
      .map((id) => ({ id: `${LOCAL_MODEL_PREFIX}${id}`, label: id }));
  }
}

/** How to start the local agent process (`bin/local-agent`). */
export interface LocalAgentCommand {
  command: string;
  args: string[];
}

const LOCAL_KIND = { name: 'Local model', harness: 'local' };

/**
 * The session a reattached turn belongs to: the first envelope the agent sent
 * names it, and the host that started the turn has already handled it.
 */
function sessionIdOnDisk(dir: string): string | undefined {
  const path = join(dir, RUNNER_OUT);
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const m = JSON.parse(line) as { method?: string; params?: SdkEnvelope };
      if (m.method === 'envelope' && m.params?.type === 'system' && m.params.sessionId)
        return m.params.sessionId;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Runs a turn on the local endpoint and records it for the history reader.
 *
 * Under a durable turn (spec/02 § Host restarts) the loop runs in its own
 * agent process under the turn runner, so a host restart does not end it and
 * the next host reattaches. Without one (a host with no runner, tests) it runs
 * in this process, as it always did.
 */
export class LocalBackend implements SdkBackend {
  private readonly engine: OpenAICompatBackend;
  constructor(
    private readonly local: LocalModels,
    private readonly history: CodexHistory,
    private readonly sessionDir: string,
    fetchImpl?: typeof fetch,
    private readonly agent?: LocalAgentCommand,
  ) {
    this.engine = new OpenAICompatBackend({
      sessionDir,
      sessionPrefix: LOCAL.sessionIdPrefix!,
      resolveEndpoint: (opts) => this.local.resolveEndpoint(opts.model),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }

  async *run(opts: SdkRunOptions): AsyncIterable<SdkEnvelope> {
    if (opts.fork) throw new Error('Branching a chat is not supported on local models yet');
    const chatId = opts.chatId ?? 'local';
    const turnId = `turn-${Date.now()}`;
    // A reattached turn's session was begun, and its prompt recorded, by the
    // host that started it.
    const reattaching = opts.durableTurn?.attach !== undefined;
    let sessionId: string | undefined;
    const source = opts.durableTurn
      ? this.runDurable(opts, opts.durableTurn)
      : this.engine.run(opts);
    for await (const envelope of source) {
      if (envelope.type === 'system' && envelope.sessionId && !sessionId) {
        sessionId = envelope.sessionId;
        if (!reattaching) {
          this.history.begin(sessionId);
          this.history.append(sessionId, turnId, chatId, { type: 'user', content: opts.prompt });
        }
      } else if (sessionId) {
        this.history.append(sessionId, turnId, chatId, envelope);
      }
      yield envelope;
    }
  }

  /** The turn, run by an agent process under its own runner. */
  private async *runDurable(
    opts: SdkRunOptions,
    req: DurableTurnRequest,
  ): AsyncIterable<SdkEnvelope> {
    if (!this.agent)
      throw new Error('This host has no local agent to run a durable local-model turn with');
    // Everything that can be refused is refused here, before a process starts.
    openaiCompatPermission(opts.permissionMode);
    const endpoint = this.local.resolveEndpoint(opts.model);
    const prefix = LOCAL.sessionIdPrefix!;
    if (opts.resumeSessionId && !opts.resumeSessionId.startsWith(prefix))
      throw new Error('Another harness’s session cannot be resumed on an OpenAI-compatible model');

    let attach = req.attach;
    const dir = turnDirFor(req.config, req.chatId);
    const recoveredSession = attach ? sessionIdOnDisk(dir) : undefined;
    if (attach && (!DurableCodexProcess.attachable(req) || recoveredSession === undefined)) {
      // Nothing the previous host started can be carried on: the turn never got
      // as far as naming its session. It is run again from its prompt.
      req.log.warn(
        { chatId: req.chatId },
        'durable local turn: the previous turn cannot be carried on; starting it again',
      );
      keepRunnerLog(dir, 'unrecoverable');
      retireTurn(dir);
      attach = undefined;
    }
    const proc = new DurableCodexProcess({ ...req, attach }, LOCAL_KIND);

    const queue: Array<{ line: string; end: number }> = [];
    let exitReason: string | undefined;
    let wake: (() => void) | undefined;
    const handlers = {
      onLine: (line: string, end: number) => {
        queue.push({ line, end });
        wake?.();
      },
      onExit: (reason: string) => {
        exitReason = reason;
        wake?.();
      },
    };
    const onAbort = (): void => {
      if (!proc.letGo) proc.kill('SIGTERM');
    };
    try {
      if (attach) {
        proc.attach(handlers);
        yield { type: 'system', sessionId: recoveredSession };
      } else {
        proc.start(
          {
            command: this.agent.command,
            args: this.agent.args,
            cwd: opts.cwd,
            env: { ...process.env },
          },
          handlers,
        );
        const start: LocalAgentStart = {
          prompt: opts.prompt,
          cwd: opts.cwd,
          baseUrl: endpoint.baseUrl,
          model: endpoint.model,
          sessionDir: this.sessionDir,
          sessionPrefix: prefix,
          ...(opts.resumeSessionId ? { resumeSessionId: opts.resumeSessionId } : {}),
          ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
          ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
          ...(opts.disabledTools ? { disabledTools: opts.disabledTools } : {}),
        };
        proc.write(JSON.stringify({ method: 'start', params: start }));
      }
      opts.abortController.signal.addEventListener('abort', onAbort);
      if (opts.abortController.signal.aborted) onAbort();
      for (;;) {
        while (queue.length === 0 && exitReason === undefined)
          await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
        const next = queue.shift();
        if (!next) throw new Error(exitReason);
        const m = JSON.parse(next.line) as {
          id?: number;
          method?: string;
          params?: unknown;
        };
        if (m.method === 'envelope') {
          const envelope = m.params as SdkEnvelope;
          if (!(attach && envelope.type === 'system')) yield envelope;
          // Handled in full once the consumer asks for the next one.
          proc.noteConsumed(next.end);
          if (envelope.type === 'result') return;
        } else if (m.method === 'permission') {
          if (!opts.onPermissionRequest)
            throw new Error('No permission handler for a gated tool call');
          const verdict = await opts.onPermissionRequest(
            m.params as Parameters<NonNullable<SdkRunOptions['onPermissionRequest']>>[0],
          );
          proc.write(JSON.stringify({ id: m.id, result: verdict }));
          proc.noteConsumed(next.end);
        } else if (m.method === 'toolBoundary') {
          const extra = await opts.onToolBoundary?.();
          proc.write(JSON.stringify({ id: m.id, result: { extra: extra ?? null } }));
          proc.noteConsumed(next.end);
        } else if (m.method === 'failed') {
          const f = m.params as LocalAgentFailure;
          throw f.turnFailed ? new OpenAICompatError(f.message, f.limit) : new Error(f.message);
        }
      }
    } finally {
      opts.abortController.signal.removeEventListener('abort', onAbort);
      proc.release();
    }
  }
}

export const localSessionDir = (patchHome: string): string => join(patchHome, 'local-sessions');
export const localHistoryDir = (patchHome: string): string => join(patchHome, 'local-history');
