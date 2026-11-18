// The Agent Client Protocol adapter (spec/02 § Provider adapters).
//
// One backend that drives any ACP agent over its stdio: spawn the agent's
// command, speak ACP to it, and translate its `session/update` stream into the
// host's envelopes. Which agent a model runs on is the caller's `resolveAgent`;
// nothing here names a vendor. Gemini CLI (`gemini --acp`) is the first.
//
// The agent's session stays where the agent keeps it. Patch holds only the id,
// as `<prefix><acpSessionId>`, and resumes with `session/load`. No fallbacks:
// an agent that cannot load a session, a refused prompt or a malformed stream
// is an error, not a guess.

import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  client,
  methods,
  ndJsonStream,
  type AgentApp,
  type McpServer,
  type PermissionOption,
  type RequestPermissionResponse,
  type SessionUpdate,
  type Stream,
} from '@agentclientprotocol/sdk';
import type { SdkBackend, SdkEnvelope, SdkRunOptions } from './sdkBackend.js';
import { TurnFailedError } from './sdkBackend.js';

export class AcpError extends TurnFailedError {}

/** The command that starts an ACP agent on stdio. */
export interface AcpAgentCommand {
  command: string;
  args: string[];
  env?: Record<string, string> | undefined;
}

export interface AcpBackendOptions {
  /** Session ids are `<prefix><acpSessionId>`; each ACP provider owns its prefix. */
  sessionPrefix: string;
  /** The agent a turn runs on. Throws when there is none (not installed). */
  resolveAgent: (opts: SdkRunOptions) => AcpAgentCommand;
  /**
   * Opens the connection to the agent. The default spawns `resolveAgent`'s
   * command; tests hand in an in-process agent. `close` ends the agent.
   */
  connect?: (opts: SdkRunOptions) => { target: Stream | AgentApp; close: () => void };
}

/** Plain async queue bridging the connection's callbacks to the generator. */
class Queue<T> {
  private items: T[] = [];
  private waiter: (() => void) | undefined;
  private done = false;
  private failure: unknown;
  push(item: T): void {
    this.items.push(item);
    this.wake();
  }
  end(failure?: unknown): void {
    this.done = true;
    this.failure = failure;
    this.wake();
  }
  private wake(): void {
    const w = this.waiter;
    this.waiter = undefined;
    w?.();
  }
  async *drain(): AsyncIterable<T> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.done) {
        if (this.failure !== undefined) throw this.failure;
        return;
      }
      await new Promise<void>((resolve) => (this.waiter = resolve));
    }
  }
}

function spawnAgent(cmd: AcpAgentCommand, cwd: string): { target: Stream; close: () => void } {
  const child: ChildProcess = spawn(cmd.command, cmd.args, {
    cwd,
    env: { ...process.env, ...(cmd.env ?? {}) },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  if (!child.stdin || !child.stdout) throw new AcpError(`${cmd.command} gave no stdio`, undefined);
  child.on('error', () => undefined);
  return {
    target: ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ),
    close: () => {
      if (child.exitCode === null) child.kill('SIGTERM');
    },
  };
}

function mcpServersFor(opts: SdkRunOptions): McpServer[] {
  const toServer = (name: string, s: { command: string; args: string[]; env?: unknown }) => {
    const env = (s.env ?? {}) as Record<string, string>;
    return {
      name,
      command: s.command,
      args: s.args,
      env: Object.entries(env).map(([k, v]) => ({ name: k, value: v })),
    };
  };
  const servers: McpServer[] = [];
  if (opts.mcpServer && !opts.patchMcpOff) servers.push(toServer('patch', opts.mcpServer));
  if (opts.mcpServer) {
    for (const extra of opts.extraMcpServers ?? []) {
      const e = extra as unknown as { name: string; command?: string; args?: string[] };
      if (e.command) servers.push(toServer(e.name, { command: e.command, args: e.args ?? [] }));
    }
  }
  return servers;
}

function pick(options: PermissionOption[], kinds: string[]): PermissionOption | undefined {
  for (const kind of kinds) {
    const found = options.find((o) => o.kind === kind);
    if (found) return found;
  }
  return undefined;
}

export class AcpBackend implements SdkBackend {
  constructor(private readonly o: AcpBackendOptions) {}

  async *run(opts: SdkRunOptions): AsyncIterable<SdkEnvelope> {
    if (opts.permissionMode === 'auto')
      throw new Error(
        'ACP agents do not support auto permissions. Choose default, accept edits, plan, or bypass permissions.',
      );
    const prior = opts.resumeSessionId;
    if (prior && !prior.startsWith(this.o.sessionPrefix))
      throw new Error('Another harness’s session cannot be resumed on an ACP agent');

    const opened = this.o.connect
      ? this.o.connect(opts)
      : spawnAgent(this.o.resolveAgent(opts), opts.cwd);
    const out = new Queue<SdkEnvelope>();
    let text = '';
    const flushText = (): void => {
      if (text) out.push({ type: 'assistant', content: text });
      text = '';
    };
    const toolNames = new Map<string, string>();

    let replaying = false;
    const onUpdate = (u: SessionUpdate): void => {
      if (replaying) return;
      switch (u.sessionUpdate) {
        case 'agent_message_chunk':
          if (u.content.type === 'text') {
            text += u.content.text;
            out.push({ type: 'assistant_delta', content: u.content.text });
          }
          return;
        case 'agent_thought_chunk':
          if (u.content.type === 'text') out.push({ type: 'system', thinking: u.content.text });
          return;
        case 'tool_call':
          flushText();
          toolNames.set(u.toolCallId, u.title);
          out.push({
            type: 'tool_use',
            tool: { name: u.title, callId: u.toolCallId, args: u.rawInput ?? {} },
          });
          return;
        case 'tool_call_update': {
          if (u.title) toolNames.set(u.toolCallId, u.title);
          if (u.status !== 'completed' && u.status !== 'failed') return;
          out.push({
            type: 'tool_result',
            toolResult: {
              name: toolNames.get(u.toolCallId) ?? u.toolCallId,
              callId: u.toolCallId,
              result: u.rawOutput ?? '',
              isError: u.status === 'failed',
            },
          });
          return;
        }
        default:
          return;
      }
    };

    const app = client({ name: 'patch' })
      .onNotification(methods.client.session.update, ({ params }) => onUpdate(params.update))
      .onRequest(methods.client.session.requestPermission, async ({ params }) => {
        const answer = await this.decide(opts, params.options, params.toolCall);
        return answer;
      });

    const turn = app
      .connectWith(opened.target, async (ctx) => {
        const init = await ctx.request(methods.agent.initialize, {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'patch', version: '0' },
        });
        const caps = init.agentCapabilities;
        let sessionId: string;
        if (prior) {
          if (!caps?.loadSession)
            throw new AcpError('This ACP agent cannot resume a saved session', undefined);
          sessionId = prior.slice(this.o.sessionPrefix.length);
          // The agent replays the saved conversation as updates while it loads;
          // that is history Patch already has, not part of this turn.
          replaying = true;
          await ctx.request(methods.agent.session.load, {
            sessionId,
            cwd: opts.cwd,
            mcpServers: mcpServersFor(opts),
          });
          replaying = false;
          out.push({ type: 'system', sessionId: prior });
        } else {
          const created = await ctx.request(methods.agent.session.new, {
            cwd: opts.cwd,
            mcpServers: mcpServersFor(opts),
          });
          sessionId = created.sessionId;
          out.push({ type: 'system', sessionId: `${this.o.sessionPrefix}${sessionId}` });
        }

        const abort = (): void => {
          void ctx.notify(methods.agent.session.cancel, { sessionId });
        };
        opts.abortController.signal.addEventListener('abort', abort, { once: true });
        try {
          const prompt: Array<Record<string, unknown>> = [{ type: 'text', text: opts.prompt }];
          if (caps?.promptCapabilities?.image)
            for (const img of opts.images ?? [])
              prompt.push({ type: 'image', mimeType: img.mediaType, data: img.data });
          const res = await ctx.request(methods.agent.session.prompt, {
            sessionId,
            prompt: prompt as never,
          });
          flushText();
          if (res.stopReason === 'cancelled') throw new AcpError('Turn interrupted', undefined);
          if (res.stopReason === 'refusal')
            throw new AcpError('The agent refused this request', undefined);
          if (res.stopReason === 'max_tokens' || res.stopReason === 'max_turn_requests')
            throw new AcpError(`The agent stopped early: ${res.stopReason}`, undefined);
          out.push({ type: 'result', sessionId: `${this.o.sessionPrefix}${sessionId}` });
        } finally {
          opts.abortController.signal.removeEventListener('abort', abort);
        }
      })
      .then(
        () => out.end(),
        (err: unknown) => out.end(err),
      );

    try {
      yield* out.drain();
    } finally {
      opened.close();
      await turn;
    }
  }

  /**
   * The models the agent offers, read from a throwaway session: the agent's own
   * model selector (a `model` config option, or the older `models` state). No
   * list is kept here, and an agent that offers none is an error.
   */
  async models(cwd: string): Promise<Array<{ id: string; label: string }>> {
    const probe = {
      prompt: '',
      cwd,
      abortController: new AbortController(),
      oauthAccessToken: '',
    } satisfies SdkRunOptions;
    const opened = this.o.connect
      ? this.o.connect(probe)
      : spawnAgent(this.o.resolveAgent(probe), cwd);
    try {
      return await client({ name: 'patch' }).connectWith(opened.target, async (ctx) => {
        await ctx.request(methods.agent.initialize, {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'patch', version: '0' },
        });
        const created = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] });
        const found: Array<{ id: string; label: string }> = [];
        const option = created.configOptions?.find(
          (c) => c.category === 'model' && c.type === 'select',
        );
        if (option && option.type === 'select') {
          for (const entry of option.options) {
            if ('value' in entry) found.push({ id: entry.value, label: entry.name });
            else for (const o of entry.options) found.push({ id: o.value, label: o.name });
          }
        }
        const legacy = (
          created as unknown as {
            models?: { availableModels?: Array<{ modelId: string; name: string }> };
          }
        ).models?.availableModels;
        for (const m of legacy ?? []) found.push({ id: m.modelId, label: m.name });
        if (found.length === 0) throw new AcpError('The ACP agent offers no model list', undefined);
        return found;
      });
    } finally {
      opened.close();
    }
  }

  /** Map an agent's permission request onto the chat's mode and the user's answer. */
  private async decide(
    opts: SdkRunOptions,
    options: PermissionOption[],
    toolCall: { title?: string | null; kind?: string | null; rawInput?: unknown },
  ): Promise<RequestPermissionResponse> {
    const select = (o: PermissionOption | undefined): RequestPermissionResponse =>
      o
        ? { outcome: { outcome: 'selected', optionId: o.optionId } }
        : { outcome: { outcome: 'cancelled' } };
    const allowOnce = pick(options, ['allow_once', 'allow_always']);
    const deny = pick(options, ['reject_once', 'reject_always']);
    const mode = opts.permissionMode;
    if (mode === 'bypassPermissions') return select(allowOnce);
    if (mode === 'plan') return select(deny);
    if (mode === 'acceptEdits' && toolCall.kind === 'edit') return select(allowOnce);
    if (!opts.onPermissionRequest) throw new Error('No permission handler for a gated tool call');
    const args = (toolCall.rawInput ?? {}) as Record<string, unknown>;
    const verdict = await opts.onPermissionRequest({
      tool: toolCall.title ?? 'tool',
      args: typeof args === 'object' ? args : { input: args },
    });
    if (!verdict.approve) return select(deny);
    return select(verdict.sessionAllow ? pick(options, ['allow_always', 'allow_once']) : allowOnce);
  }
}
