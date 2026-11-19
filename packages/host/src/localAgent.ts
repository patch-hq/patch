// The local-model agent process (spec/02 § Host restarts).
//
// A local-model turn is a loop the host used to run in its own process:
// stream the model's reply, run the tools it asks for, feed the results back.
// That died with the host. Here the same loop (`OpenAICompatBackend`) runs in
// a process of its own, started under the per-turn runner (`turnRunner.ts`)
// exactly as `codex app-server` is, so the turn carries on through a host
// restart and the next host reattaches to it (`DurableCodexProcess`).
//
// It speaks JSON-RPC-shaped lines, which is what lets it ride the Codex
// machinery unchanged: the runner keeps every line on disk, and a reattaching
// host is handed whatever the previous one had not handled plus every request
// it had not answered.
//
//   host → agent   {"method":"start","params":LocalAgentStart}   once, first
//                  {"id":n,"result":...}                          an answer
//   agent → host   {"method":"envelope","params":SdkEnvelope}    one per envelope
//                  {"id":n,"method":"permission","params":req}   a gated tool call
//                  {"id":n,"method":"toolBoundary"}               "anything to add?"
//                  {"method":"failed","params":LocalAgentFailure} the turn failed
//
// SIGTERM stops the turn the way an abort does in-process: the loop ends, the
// session is saved, and the failure is reported.

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { OpenAICompatBackend, type Message } from './openaiCompatBackend.js';
import { TurnFailedError, type LimitFacts, type SdkRunOptions } from './sdkBackend.js';

/** What the host hands the agent to run one turn. */
export interface LocalAgentStart {
  prompt: string;
  cwd: string;
  baseUrl: string;
  model: string;
  sessionDir: string;
  sessionPrefix: string;
  resumeSessionId?: string;
  systemPrompt?: string;
  permissionMode?: SdkRunOptions['permissionMode'];
  disabledTools?: string[];
}

export interface LocalAgentFailure {
  message: string;
  /** The error was a turn failure the provider reported, not a crash. */
  turnFailed: boolean;
  limit?: LimitFacts;
}

type Rpc = Record<string, any>;

/** Run one turn over `input`/`output`. Resolves with the process exit code. */
export async function runLocalAgent(
  input: Readable,
  output: Writable,
  onSignal: (stop: () => void) => void = (stop) => process.once('SIGTERM', stop),
): Promise<number> {
  const send = (msg: Rpc): Promise<void> =>
    new Promise((resolve, reject) =>
      output.write(`${JSON.stringify(msg)}\n`, (err) => (err ? reject(err) : resolve())),
    );
  const waiting = new Map<number, (result: unknown) => void>();
  let nextId = 1;
  const request = (method: string, params?: unknown): Promise<any> => {
    const id = nextId++;
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      void send({ id, method, ...(params !== undefined ? { params } : {}) });
    });
  };

  let resolveStart!: (s: LocalAgentStart) => void;
  const started = new Promise<LocalAgentStart>((r) => (resolveStart = r));
  const lines = createInterface({ input });
  lines.on('line', (line) => {
    let m: Rpc;
    try {
      m = JSON.parse(line) as Rpc;
    } catch {
      return;
    }
    if (m['method'] === 'start') resolveStart(m['params'] as LocalAgentStart);
    else if (m['id'] !== undefined && m['method'] === undefined) {
      const answer = waiting.get(m['id']);
      waiting.delete(m['id']);
      answer?.(m['result']);
    }
  });

  const start = await started;
  const abortController = new AbortController();
  onSignal(() => abortController.abort());
  const engine = new OpenAICompatBackend({
    sessionDir: start.sessionDir,
    sessionPrefix: start.sessionPrefix,
    // A local endpoint takes no key.
    resolveEndpoint: () => ({ baseUrl: start.baseUrl, model: start.model }),
  });
  const opts = {
    prompt: start.prompt,
    cwd: start.cwd,
    model: start.model,
    abortController,
    oauthAccessToken: '',
    permissionMode: start.permissionMode,
    ...(start.disabledTools ? { disabledTools: start.disabledTools } : {}),
    ...(start.systemPrompt !== undefined ? { systemPrompt: start.systemPrompt } : {}),
    ...(start.resumeSessionId !== undefined ? { resumeSessionId: start.resumeSessionId } : {}),
    onPermissionRequest: (req: unknown) => request('permission', req),
    onToolBoundary: async () =>
      ((await request('toolBoundary')) as { extra?: string | null } | undefined)?.extra ??
      undefined,
  } as SdkRunOptions;
  try {
    for await (const envelope of engine.run(opts))
      await send({ method: 'envelope', params: envelope });
    return 0;
  } catch (err) {
    const failure: LocalAgentFailure = {
      message: err instanceof Error ? err.message : String(err),
      turnFailed: err instanceof TurnFailedError,
      ...(err instanceof TurnFailedError && err.limit !== undefined ? { limit: err.limit } : {}),
    };
    await send({ method: 'failed', params: failure });
    return 1;
  } finally {
    lines.close();
  }
}
