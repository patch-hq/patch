// Local models (docs/providers.md § Proposed suite): an Ollama, llama.cpp or
// LM Studio server reached through its OpenAI-compatible endpoint, served by
// the generic OpenAI-compatible engine. The endpoint is account-wide shared
// setting (`localModelBaseUrl`); the models on offer are whatever the
// endpoint itself lists. Nothing here calls a paid API, and there is no
// fallback: an unset or unreachable endpoint is an error that says so.

import { join } from 'node:path';
import { providerDescriptor } from '@patch/wire';
import type { SdkBackend, SdkEnvelope, SdkRunOptions } from './sdkBackend.js';
import { CodexHistory } from './codexHistory.js';
import { OpenAICompatBackend, type Message } from './openaiCompatBackend.js';
import { toChatCompletionMessages } from './nativeReconstruct.js';

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

/** Runs a turn on the local endpoint and records it for the history reader. */
export class LocalBackend implements SdkBackend {
  private readonly engine: OpenAICompatBackend;
  constructor(
    private readonly local: LocalModels,
    private readonly history: CodexHistory,
    sessionDir: string,
    fetchImpl?: typeof fetch,
  ) {
    this.engine = new OpenAICompatBackend({
      sessionDir,
      sessionPrefix: LOCAL.sessionIdPrefix!,
      resolveEndpoint: (opts) => this.local.resolveEndpoint(opts.model),
      seedMessages: (opts) =>
        opts.localReseed
          ? (toChatCompletionMessages(opts.localReseed.events) as Message[])
          : undefined,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
  }

  async *run(opts: SdkRunOptions): AsyncIterable<SdkEnvelope> {
    if (opts.fork) throw new Error('Branching a chat is not supported on local models yet');
    const chatId = opts.chatId ?? 'local';
    const turnId = `turn-${Date.now()}`;
    let sessionId: string | undefined;
    for await (const envelope of this.engine.run(opts)) {
      if (envelope.type === 'system' && envelope.sessionId && !sessionId) {
        sessionId = envelope.sessionId;
        this.history.begin(sessionId);
        this.history.append(sessionId, turnId, chatId, { type: 'user', content: opts.prompt });
      } else if (sessionId) {
        this.history.append(sessionId, turnId, chatId, envelope);
      }
      yield envelope;
    }
  }
}

export const localSessionDir = (patchHome: string): string => join(patchHome, 'local-sessions');
export const localHistoryDir = (patchHome: string): string => join(patchHome, 'local-history');
