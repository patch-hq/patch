// The Agent Client Protocol adapter's turn runner (spec/02 § Provider
// adapters).
//
// One turn is one agent process: `initialize`, then a session — new, or the
// chat's own saved one reopened with `session/resume` or `session/load` where
// the agent advertises either — then the model and mode the chat runs on,
// then `session/prompt`. Everything the agent says while the prompt runs
// becomes the turn's envelopes (`acpTranslate.ts`), its permission requests
// go through Patch's permission flow, and a stop is `session/cancel`.
//
// Under the host's detached turn runner (`codexDurable.ts`, the same one a
// Codex turn uses: both are JSON-RPC lines on stdio) the agent outlives a
// host restart. The next host reattaches: it reads from the runner's files
// which session and which prompt request the turn is on, is handed what the
// agent said that the previous host had not handled, re-asks any permission
// the previous host had not answered, and waits for the prompt's answer. ACP
// itself has no way to rejoin a running prompt from a new process, which is
// why the runner, not the agent, is what is reattached to.
//
// A chat's session id is `acp-<agent>-r-<the agent's session id>` (or `-h-`
// and the id in hex, for an agent whose ids have characters Patch's session
// ids cannot carry).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAcpModel, type AcpAgentConfig } from '@patch/wire';
import type {
  InitializeResponse,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { AcpClosedError, AcpConnection, AcpRpcError } from './acpConnection.js';
import { AcpChildProcess } from './acpProcess.js';
import {
  agentCapabilities,
  initializeParams,
  isAuthError,
  type AcpRegistry,
} from './acpRegistry.js';
import { AcpTranslator } from './acpTranslate.js';
import { DurableCodexProcess } from './codexDurable.js';
import type { CodexHistory } from './codexHistory.js';
import { keepRunnerLog, retireTurn, turnDirFor } from './durableTurn.js';
import { RUNNER_IN, RUNNER_OUT } from './turnRunner.js';
import {
  TurnFailedError,
  type SdkBackend,
  type SdkEnvelope,
  type SdkRunOptions,
} from './sdkBackend.js';

export const ACP_SESSION_PREFIX = 'acp-';

export function encodeAcpSessionId(agentId: string, nativeId: string): string {
  return /^[A-Za-z0-9-]+$/.test(nativeId)
    ? `${ACP_SESSION_PREFIX}${agentId}-r-${nativeId}`
    : `${ACP_SESSION_PREFIX}${agentId}-h-${Buffer.from(nativeId, 'utf8').toString('hex')}`;
}

export function decodeAcpSessionId(
  id: string | undefined,
): { agentId: string; nativeId: string } | undefined {
  const m = /^acp-([a-z0-9]+)-(r|h)-(.+)$/.exec(id ?? '');
  if (!m) return undefined;
  return {
    agentId: m[1]!,
    nativeId: m[2] === 'r' ? m[3]! : Buffer.from(m[3]!, 'hex').toString('utf8'),
  };
}

/** A turn the agent refused for want of a sign-in or key. */
export class AcpSignedOutError extends TurnFailedError {
  override readonly name = 'AcpSignedOutError';
  constructor(label: string) {
    super(
      `${label} is not signed in on this host. Add an account for it under Settings → AI accounts, or sign in to it on this host.`,
      undefined,
    );
  }
}

/**
 * A turn the agent refused with a quota or rate limit. `retrySafe` says no tool
 * ran before the refusal, so the turn can run again on another account without
 * doing anything twice (spec/10 § Limits).
 */
export class AcpLimitError extends TurnFailedError {
  override readonly name = 'AcpLimitError';
  constructor(
    message: string,
    readonly retrySafe: boolean,
  ) {
    super(message, { kind: 'rate_limit', status: 'rejected' });
  }
}

/** What a turn directory says about the ACP turn it holds. */
export interface RecoveredAcpTurn {
  sessionId?: string;
  promptId?: number | string;
  /** The highest request id the previous host used. */
  maxRequestId: number;
  /** End offset in `out.jsonl` of the session's opening answer: what came before is setup. */
  setupEnd: number;
  /** The prompt's answer, if the agent gave it while no host was attached. */
  promptAnswer?: { result?: PromptResponse; error?: { code: number; message: string } };
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
}

function parse(line: string): Record<string, any> | undefined {
  try {
    const v = JSON.parse(line) as unknown;
    return typeof v === 'object' && v !== null ? (v as Record<string, any>) : undefined;
  } catch {
    return undefined;
  }
}

/** Read what the previous host said to the agent and what it answered. */
export function recoverAcpTurn(dir: string): RecoveredAcpTurn {
  const out: RecoveredAcpTurn = { maxRequestId: -1, setupEnd: 0 };
  const methodById = new Map<number | string, string>();
  for (const line of lines(join(dir, RUNNER_IN))) {
    const m = parse(line);
    if (!m || m['id'] === undefined || typeof m['method'] !== 'string') continue;
    methodById.set(m['id'], m['method']);
    if (typeof m['id'] === 'number') out.maxRequestId = Math.max(out.maxRequestId, m['id']);
    if (m['method'] === 'session/prompt') {
      out.promptId = m['id'];
      out.sessionId = m['params']?.sessionId;
    }
  }
  let offset = 0;
  for (const line of lines(join(dir, RUNNER_OUT))) {
    offset += Buffer.byteLength(line, 'utf8') + 1;
    const m = parse(line);
    if (!m || typeof m['method'] === 'string' || m['id'] === undefined) continue;
    const method = methodById.get(m['id']);
    if (method === 'session/new' || method === 'session/load' || method === 'session/resume')
      out.setupEnd = offset;
    if (out.promptId !== undefined && m['id'] === out.promptId)
      out.promptAnswer = m['error'] ? { error: m['error'] } : { result: m['result'] };
  }
  return out;
}

/** The transport a turn's agent runs on: a runner the host can let go of, or a child. */
interface TurnProcess {
  write(line: string): void;
  stop(): void;
  release(): void;
  stderrTail(): string;
  noteConsumed?(end: number): void;
}

type QueueItem = { env: SdkEnvelope } | { consumed: number };

const CANCEL_GRACE_MS = 15_000;

export class AcpBackend implements SdkBackend {
  constructor(
    private readonly registry: AcpRegistry,
    readonly history: CodexHistory,
    private readonly clientVersion: string,
    /** Told when the agent refuses the account a turn ran on as signed out, so it is skipped. */
    private readonly onAccountSignedOut?: (accountId: string) => void,
  ) {}

  async *run(opts: SdkRunOptions): AsyncIterable<SdkEnvelope> {
    try {
      yield* this.runTurn(opts);
    } catch (err) {
      if (err instanceof AcpSignedOutError && opts.accountId !== undefined)
        this.onAccountSignedOut?.(opts.accountId);
      throw err;
    }
  }

  private async *runTurn(opts: SdkRunOptions): AsyncIterable<SdkEnvelope> {
    const parsed = parseAcpModel(opts.model);
    if (!parsed) throw new Error(`${opts.model ?? 'No model'} is not an ACP agent's model`);
    const agent = this.registry.agent(parsed.agentId);
    if (!agent)
      throw new TurnFailedError(
        `No ACP agent "${parsed.agentId}" is configured on this account.`,
        undefined,
      );
    const command = this.registry.command(agent);
    if (!command)
      throw new TurnFailedError(`${agent.label} is not installed on this host.`, undefined);
    if (opts.fork) throw new Error(`${agent.label} cannot branch a chat`);
    const prior = opts.resumeSessionId;
    const priorSession = decodeAcpSessionId(prior);
    if (prior && !priorSession)
      throw new Error(`Another provider's session cannot be resumed on ${agent.label}`);
    if (priorSession && priorSession.agentId !== agent.id)
      throw new Error(
        `This chat's session belongs to another ACP agent; ${agent.label} cannot continue it`,
      );
    const mcpServers = acpMcpServers(opts, agent.label);
    const mode = opts.permissionMode ?? 'default';
    if (mode === 'auto' || mode === 'plan')
      throw new Error(
        `${agent.label} runs with default, accept edits or bypass permissions; it has no ${mode} mode in Patch.`,
      );

    const durableReq = opts.durableTurn;
    let recovered: RecoveredAcpTurn | undefined;
    let start: () => void;
    if (durableReq?.attach && DurableCodexProcess.attachable(durableReq)) {
      const dir = turnDirFor(durableReq.config, durableReq.chatId);
      recovered = recoverAcpTurn(dir);
      if (recovered.promptId === undefined || recovered.sessionId === undefined) {
        durableReq.log.warn(
          { chatId: durableReq.chatId },
          'durable acp turn: the previous turn never sent its prompt; starting it again',
        );
        keepRunnerLog(dir, 'unrecoverable');
        retireTurn(dir);
        recovered = undefined;
      }
    }

    // ---- the process ----
    const queue: QueueItem[] = [];
    let wake: (() => void) | undefined;
    /** A tool of the agent's ran this turn: running it again would repeat it. */
    let toolsRan = false;
    const pushEnvelopes = (envs: SdkEnvelope[]): void => {
      for (const env of envs) {
        if (env.type === 'tool_use' && env.tool?.name !== 'TodoWrite') toolsRan = true;
        queue.push({ env });
      }
      wake?.();
    };
    let lineAt = 0;
    let lineCount = 0;
    let suppressUpdates = false;
    let setupEnd = 0;
    let translator: AcpTranslator | undefined;
    let nativeSessionId: string | undefined = priorSession?.nativeId;
    let exitReason: string | undefined;
    const pendingAsks = new Set<(r: RequestPermissionResponse) => void>();
    const aborted = (): boolean => opts.abortController.signal.aborted;

    let proc!: TurnProcess;
    // A reattached connection numbers its requests past the previous host's.
    const conn: AcpConnection = new AcpConnection(
      (line) => proc.write(line),
      {
        onNotification: (method, params) => {
          if (method !== 'session/update' || suppressUpdates || !translator) return;
          if (lineAt !== 0 && lineAt <= setupEnd) return;
          const n = params as SessionNotification;
          if (nativeSessionId !== undefined && n.sessionId !== nativeSessionId) return;
          pushEnvelopes(translator.push(n.update, String(lineAt || lineCount)));
        },
        onRequest: async (method, params) => {
          if (method !== 'session/request_permission')
            throw new AcpRpcError(method, -32601, `Patch does not offer ${method}`);
          return this.answerPermission(
            params as RequestPermissionRequest,
            opts,
            agent,
            () => translator,
            pushEnvelopes,
            pendingAsks,
          );
        },
        onStray: () => undefined,
      },
      recovered ? { firstId: recovered.maxRequestId + 1 } : {},
    );

    const onLine = (line: string, end?: number): void => {
      lineCount += 1;
      lineAt = end ?? 0;
      conn.receive(line);
      if (end !== undefined) {
        queue.push({ consumed: end });
        wake?.();
      }
    };
    const onExit = (reason: string): void => {
      exitReason = reason;
      conn.close(reason);
      wake?.();
    };

    if (durableReq) {
      const durable = new DurableCodexProcess(
        recovered ? durableReq : { ...durableReq, attach: undefined },
        { name: agent.label, harness: 'acp' },
      );
      proc = {
        write: (line) => durable.write(line),
        stop: () => durable.kill('SIGTERM'),
        release: () => durable.release(),
        stderrTail: () => durable.stderrTail().slice(-3).join(' '),
        noteConsumed: (end) => durable.noteConsumed(end),
      };
      if (recovered) {
        setupEnd = recovered.setupEnd;
        nativeSessionId = recovered.sessionId;
      }
      // Lines arrive only once the turn starts it, below.
      start = (): void => {
        if (recovered) durable.attach({ onLine, onExit });
        else
          durable.start(
            {
              command,
              args: agent.args,
              cwd: opts.cwd,
              env: this.registry.env(agent, opts.accountId),
            },
            { onLine, onExit },
          );
      };
    } else {
      const child = new AcpChildProcess({
        command,
        args: agent.args,
        cwd: opts.cwd,
        env: this.registry.env(agent, opts.accountId),
      });
      proc = {
        write: (line) => child.write(line),
        stop: () => child.kill(),
        release: () => child.kill(),
        stderrTail: () => child.stderrTail().split('\n').slice(-3).join(' '),
      };
      start = (): void => child.start((line) => onLine(line), onExit);
    }

    let cancelTimer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      for (const resolve of pendingAsks) resolve({ outcome: { outcome: 'cancelled' } });
      pendingAsks.clear();
      if (nativeSessionId !== undefined)
        conn.notify('session/cancel', { sessionId: nativeSessionId });
      // An agent that never answers a cancel is ended.
      cancelTimer = setTimeout(() => proc.stop(), CANCEL_GRACE_MS);
      cancelTimer.unref?.();
      wake?.();
    };

    // A reattached turn's translator and prompt answer are in place before the
    // runner hands back the turn's output, which can happen at once.
    let promptAnswer: Promise<PromptResponse> | undefined;
    if (recovered) {
      translator = new AcpTranslator(`${recovered.sessionId}:${String(recovered.promptId)}`);
      const answered = recovered.promptAnswer;
      promptAnswer = answered
        ? answered.error
          ? Promise.reject(
              new AcpRpcError('session/prompt', answered.error.code, answered.error.message),
            )
          : Promise.resolve(answered.result!)
        : conn.await<PromptResponse>(recovered.promptId!, 'session/prompt');
      // Observed below; never an unhandled rejection meanwhile.
      promptAnswer.catch(() => undefined);
    }

    try {
      start();
      let sessionId: string;
      if (recovered) {
        sessionId = encodeAcpSessionId(agent.id, recovered.sessionId!);
        this.history.begin(sessionId);
        yield { type: 'system', sessionId };
      } else {
        const opened = await this.openSession(
          conn,
          agent,
          opts,
          mcpServers,
          priorSession?.nativeId,
          {
            suppress: (on) => {
              suppressUpdates = on;
            },
          },
        );
        nativeSessionId = opened.nativeId;
        sessionId = encodeAcpSessionId(agent.id, opened.nativeId);
        this.history.begin(sessionId);
        yield { type: 'system', sessionId };
        await this.chooseModel(conn, agent, opened.nativeId, opened.session, parsed.modelId);
        await this.chooseMode(conn, agent, opened.nativeId, opened.session, mode);
        if (aborted()) return;
        const promptId = conn.peekNextId();
        translator = new AcpTranslator(`${opened.nativeId}:${String(promptId)}`);
        this.history.append(sessionId, String(promptId), opts.chatId ?? sessionId, {
          type: 'user',
          content: opts.prompt,
        });
        promptAnswer = conn.request<PromptResponse>('session/prompt', {
          sessionId: opened.nativeId,
          prompt: promptBlocks(opts, agent, opened.capabilities.image),
        });
      }
      opts.abortController.signal.addEventListener('abort', onAbort, { once: true });
      if (aborted()) onAbort();

      let settled: { result?: PromptResponse; error?: unknown } | undefined;
      promptAnswer!.then(
        (result) => {
          settled = { result };
          wake?.();
        },
        (error: unknown) => {
          settled = { error };
          wake?.();
        },
      );
      const turnTranslator = translator!;
      const turnRef = turnTranslator.key;
      for (;;) {
        while (queue.length > 0) {
          const item = queue.shift()!;
          if ('consumed' in item) {
            proc.noteConsumed?.(item.consumed);
            continue;
          }
          this.history.append(sessionId, turnRef, opts.chatId ?? sessionId, item.env);
          yield item.env;
        }
        if (settled) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (queue.length > 0 || settled) resolve();
        });
        wake = undefined;
      }
      for (const env of turnTranslator.flush()) {
        this.history.append(sessionId, turnRef, opts.chatId ?? sessionId, env);
        yield env;
      }
      const s = settled as { result?: PromptResponse; error?: unknown };
      if (s.error !== undefined) {
        if (aborted() && (s.error instanceof AcpClosedError || s.error instanceof AcpRpcError))
          return;
        throw this.turnError(agent, s.error, exitReason, proc.stderrTail(), toolsRan);
      }
      const stop = s.result?.stopReason;
      this.registry.noteTurn(agent.id, { state: { state: 'ready' } });
      if (stop === 'cancelled') return;
      if (stop === 'max_tokens')
        throw new TurnFailedError(
          `${agent.label} stopped the turn: the reply reached its token limit.`,
          undefined,
        );
      if (stop === 'max_turn_requests')
        throw new TurnFailedError(
          `${agent.label} stopped the turn: it reached its limit of model requests for one turn.`,
          undefined,
        );
      yield { type: 'result', sessionId };
    } finally {
      opts.abortController.signal.removeEventListener('abort', onAbort);
      clearTimeout(cancelTimer);
      conn.close('turn over');
      proc.release();
    }
  }

  /** Start the chat's session, or reopen its saved one. */
  private async openSession(
    conn: AcpConnection,
    agent: AcpAgentConfig,
    opts: SdkRunOptions,
    mcpServers: unknown[],
    priorNativeId: string | undefined,
    hooks: { suppress(on: boolean): void },
  ): Promise<{
    nativeId: string;
    session: NewSessionResponse & { models?: unknown };
    capabilities: ReturnType<typeof agentCapabilities>;
  }> {
    let init: InitializeResponse;
    try {
      init = await conn.request<InitializeResponse>(
        'initialize',
        initializeParams(this.clientVersion),
      );
    } catch (err) {
      throw this.turnError(agent, err, undefined, '');
    }
    if (init.protocolVersion !== 1)
      throw new TurnFailedError(
        `${agent.label} speaks ACP version ${String(init.protocolVersion)}; Patch speaks version 1.`,
        undefined,
      );
    const capabilities = agentCapabilities(init);
    this.registry.noteTurn(agent.id, {
      capabilities,
      ...(init.agentInfo?.version ? { version: init.agentInfo.version } : {}),
    });
    try {
      if (priorNativeId === undefined) {
        const session = await conn.request<NewSessionResponse>('session/new', {
          cwd: opts.cwd,
          mcpServers,
        });
        return { nativeId: session.sessionId, session, capabilities };
      }
      if (capabilities.resumeSession) {
        const session = await conn.request<NewSessionResponse>('session/resume', {
          sessionId: priorNativeId,
          cwd: opts.cwd,
          mcpServers,
        });
        return {
          nativeId: priorNativeId,
          session: { ...session, sessionId: priorNativeId },
          capabilities,
        };
      }
      if (capabilities.loadSession) {
        // `session/load` replays the conversation as updates before it answers.
        // Patch's record already holds it, so the replay is not recorded again.
        hooks.suppress(true);
        try {
          const session = await conn.request<NewSessionResponse>('session/load', {
            sessionId: priorNativeId,
            cwd: opts.cwd,
            mcpServers,
          });
          return {
            nativeId: priorNativeId,
            session: { ...(session ?? {}), sessionId: priorNativeId },
            capabilities,
          };
        } finally {
          hooks.suppress(false);
        }
      }
      throw new TurnFailedError(
        `${agent.label} cannot reopen a saved session, so this chat cannot continue with the model's memory. Its history stays readable; start a new chat to carry on.`,
        undefined,
      );
    } catch (err) {
      if (err instanceof TurnFailedError) throw err;
      throw this.turnError(agent, err, undefined, '');
    }
  }

  /** Put the session on the chat's model, if the agent offers a choice. */
  private async chooseModel(
    conn: AcpConnection,
    agent: AcpAgentConfig,
    sessionId: string,
    session: NewSessionResponse & { models?: unknown },
    modelId: string,
  ): Promise<void> {
    if (modelId === 'default') return;
    const option = (session.configOptions ?? []).find(
      (o): o is SessionConfigOption & { type: 'select' } =>
        o.category === 'model' && o.type === 'select',
    );
    if (option) {
      if (option.currentValue === modelId) return;
      await conn.request('session/set_config_option', {
        sessionId,
        configId: option.id,
        value: modelId,
      });
      return;
    }
    const models = session.models as { currentModelId?: unknown } | undefined;
    if (models) {
      if (models.currentModelId === modelId) return;
      await conn.request('session/set_model', { sessionId, modelId });
      return;
    }
    throw new TurnFailedError(
      `${agent.label} offers no choice of model, so it cannot run ${modelId}.`,
      undefined,
    );
  }

  /** Put the session in the agent's own mode for the chat's permission mode, if it has one. */
  private async chooseMode(
    conn: AcpConnection,
    agent: AcpAgentConfig,
    sessionId: string,
    session: NewSessionResponse,
    mode: 'default' | 'acceptEdits' | 'bypassPermissions',
  ): Promise<void> {
    const wanted = agent.modes?.[mode];
    if (!wanted || !session.modes) return;
    if (!session.modes.availableModes.some((m) => m.id === wanted)) return;
    if (session.modes.currentModeId === wanted) return;
    await conn.request('session/set_mode', { sessionId, modeId: wanted });
  }

  /**
   * The agent asks before a tool call. Under bypass every call is allowed, and
   * under accept edits every edit; anything else goes to the user through
   * Patch's permission flow.
   */
  private async answerPermission(
    req: RequestPermissionRequest,
    opts: SdkRunOptions,
    agent: AcpAgentConfig,
    translator: () => AcpTranslator | undefined,
    push: (envs: SdkEnvelope[]) => void,
    pendingAsks: Set<(r: RequestPermissionResponse) => void>,
  ): Promise<RequestPermissionResponse> {
    const cancelled: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };
    if (opts.abortController.signal.aborted) return cancelled;
    const pick = (...kinds: string[]): string | undefined => {
      for (const kind of kinds) {
        const o = req.options.find((x) => x.kind === kind);
        if (o) return o.optionId;
      }
      return undefined;
    };
    const selected = (optionId: string | undefined): RequestPermissionResponse =>
      optionId === undefined ? cancelled : { outcome: { outcome: 'selected', optionId } };
    const t = translator();
    const tool = t
      ? t.ensureTool(req.toolCall)
      : { envelopes: [], name: req.toolCall.title ?? 'tool', args: {} };
    push(tool.envelopes);
    const mode = opts.permissionMode ?? 'default';
    const kind = req.toolCall.kind ?? undefined;
    if (
      mode === 'bypassPermissions' ||
      (mode === 'acceptEdits' && (kind === 'edit' || kind === 'delete' || kind === 'move'))
    )
      return selected(pick('allow_once', 'allow_always'));
    if (!opts.onPermissionRequest)
      throw new Error(`${agent.label} asked permission and this turn has no way to ask the user`);
    const ask = opts.onPermissionRequest({
      tool: tool.name,
      args: tool.args,
      ...(req.toolCall.title ? { description: req.toolCall.title } : {}),
    });
    let release: (r: RequestPermissionResponse) => void = () => undefined;
    const abandoned = new Promise<RequestPermissionResponse>((resolve) => {
      release = resolve;
      pendingAsks.add(resolve);
    });
    try {
      return await Promise.race([
        ask.then((verdict) =>
          verdict.approve
            ? selected(
                verdict.sessionAllow
                  ? pick('allow_always', 'allow_once')
                  : pick('allow_once', 'allow_always'),
              )
            : selected(pick('reject_once', 'reject_always')),
        ),
        abandoned,
      ]);
    } finally {
      pendingAsks.delete(release);
    }
  }

  private turnError(
    agent: AcpAgentConfig,
    err: unknown,
    exitReason: string | undefined,
    stderr: string,
    toolsRan = false,
  ): Error {
    if (isAuthError(err)) {
      this.registry.noteTurn(agent.id, { state: { state: 'signed_out' } });
      return new AcpSignedOutError(agent.label);
    }
    if (err instanceof AcpClosedError) {
      const tail = stderr ? ` (${stderr.slice(-300)})` : '';
      return new TurnFailedError(
        `${agent.label} ${exitReason ?? 'exited'} before finishing the turn${tail}`,
        undefined,
      );
    }
    const message = (err as Error).message ?? String(err);
    if (/\b429\b|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(message)) {
      this.registry.noteTurn(agent.id, { state: { state: 'limited' } });
      return new AcpLimitError(`${agent.label}: ${message}`, !toolsRan);
    }
    if (err instanceof TurnFailedError) return err;
    return new TurnFailedError(`${agent.label}: ${message}`, undefined);
  }
}

/** The prompt as ACP content: the text, and images where the agent takes them. */
function promptBlocks(
  opts: SdkRunOptions,
  agent: AcpAgentConfig,
  acceptsImages: boolean,
): Array<Record<string, unknown>> {
  if (opts.images?.length && !acceptsImages)
    throw new TurnFailedError(`${agent.label} does not accept images.`, undefined);
  return [
    { type: 'text', text: opts.prompt },
    ...(opts.images ?? []).map((i) => ({ type: 'image', mimeType: i.mediaType, data: i.data })),
  ];
}

/**
 * The MCP servers the agent's session gets: Patch's own tools first, then the
 * host's enabled servers. ACP has no per-tool switch, so a Patch tool the
 * chat has switched off is left out of Patch's server, and a switched-off tool
 * of any other server is refused loudly rather than left on.
 */
export function acpMcpServers(
  opts: Pick<SdkRunOptions, 'mcpServer' | 'extraMcpServers' | 'patchMcpOff' | 'disabledTools'>,
  label: string,
): Array<Record<string, unknown>> {
  if (!opts.mcpServer) return [];
  const patchOff: string[] = [];
  const unsupported: string[] = [];
  for (const id of new Set(opts.disabledTools ?? [])) {
    const m = /^mcp__patch__(.+)$/.exec(id);
    if (m) patchOff.push(m[1]!);
    else unsupported.push(id);
  }
  if (unsupported.length)
    throw new Error(
      `${label} cannot switch off these tools for this chat: ${unsupported.join(', ')}`,
    );
  const env = (e: Record<string, string>): Array<{ name: string; value: string }> =>
    Object.entries(e).map(([name, value]) => ({ name, value }));
  const servers: Array<Record<string, unknown>> = [];
  if (!opts.patchMcpOff) {
    let args = opts.mcpServer.args;
    if (patchOff.length) {
      const prev = args.find((a) => a.startsWith('--omit-tools='));
      const merged = [
        ...(prev ? prev.slice('--omit-tools='.length).split(',').filter(Boolean) : []),
        ...patchOff,
      ];
      args = [...args.filter((a) => a !== prev), `--omit-tools=${[...new Set(merged)].join(',')}`];
    }
    servers.push({
      name: 'patch',
      command: opts.mcpServer.command,
      args,
      env: env(opts.mcpServer.env),
    });
  }
  for (const s of opts.extraMcpServers ?? []) {
    servers.push(
      'url' in s
        ? { type: 'http', name: s.name, url: s.url, headers: [] }
        : { name: s.name, command: s.command, args: s.args, env: env(s.env) },
    );
  }
  return servers;
}
