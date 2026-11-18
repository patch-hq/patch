// ACP turns end to end (spec/02 § Provider adapters): the real adapter driving
// a fake ACP agent process built on the official ACP library — a turn on its
// own, a turn under the detached runner carried across a host restart, and a
// chat on an ACP model run through the host's chat core.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { AcpBackend, AcpSignedOutError } from '../src/acpBackend.js';
import { AcpRegistry } from '../src/acpRegistry.js';
import { CodexHistory } from '../src/codexHistory.js';
import {
  detachDurableTurns,
  inspectTurn,
  resetDurableTurnsForTest,
  type DurableTurnConfig,
} from '../src/durableTurn.js';
import { TurnFailedError, type SdkEnvelope, type SdkRunOptions } from '../src/sdkBackend.js';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { fakeAgent } from './fixtures/acpFake.js';

const here = dirname(fileURLToPath(import.meta.url));
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(() => resetDurableTurnsForTest());

function setup(env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acp-turn-'));
  const cwd = join(root, 'cwd');
  const state = join(root, 'agent-state');
  mkdirSync(cwd);
  mkdirSync(state);
  const agentLog = join(root, 'agent.log');
  const registry = new AcpRegistry({
    providerKey: () => undefined,
    baseEnv: () => ({ ...process.env, FAKE_ACP_STATE: state, FAKE_ACP_LOG: agentLog, ...env }),
    scratchDir: join(root, 'scratch'),
    clientVersion: '1.0.0',
  });
  registry.setConfigured([fakeAgent()]);
  const history = new CodexHistory(join(root, 'history'), 'acp');
  const backend = new AcpBackend(registry, history, '1.0.0');
  const config: DurableTurnConfig = {
    turnsDir: join(root, 'turns'),
    runner: {
      command: process.execPath,
      args: ['--import', tsx, resolve(here, '../src/bin/turn-runner.ts')],
    },
  };
  const requests = (): Array<{ method: string; params: any }> =>
    readFileSync(agentLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return { root, cwd, registry, backend, history, config, requests };
}

function opts(over: Partial<SdkRunOptions>): SdkRunOptions {
  return {
    prompt: 'hello',
    cwd: '/',
    chatId: 'c1',
    model: 'acp/fake/fake-pro',
    permissionMode: 'default',
    oauthAccessToken: '',
    abortController: new AbortController(),
    ...over,
  } as SdkRunOptions;
}

async function collect(it: AsyncIterable<SdkEnvelope>): Promise<SdkEnvelope[]> {
  const out: SdkEnvelope[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const said = (envs: SdkEnvelope[]) =>
  envs.filter((e) => e.type === 'assistant').map((e) => e.content);

describe('an ACP turn', () => {
  it('runs a turn: text, thought, a tool call asked through Patch, a plan, and the result', async () => {
    const { backend, cwd, history, requests } = setup();
    const asked: unknown[] = [];
    const envs = await collect(
      backend.run(
        opts({
          cwd,
          model: 'acp/fake/fake-flash',
          mcpServer: { command: 'node', args: ['mcp.js'], env: { PATCH_CHAT_ID: 'c1' } },
          onPermissionRequest: async (req) => {
            asked.push(req);
            return { approve: true };
          },
        }),
      ),
    );
    const sessionId = envs[0]!.sessionId!;
    expect(envs[0]).toEqual({ type: 'system', sessionId: expect.stringMatching(/^acp-fake-r-/) });
    expect(asked).toEqual([
      { tool: 'List files', args: { command: 'ls' }, description: 'List files' },
    ]);
    expect(said(envs)).toEqual(['Hello there', 'done:yes:fake-flash:default']);
    expect(envs.find((e) => e.thinking)?.thinking).toBe('pondering');
    const tool = envs.find((e) => e.type === 'tool_use' && e.tool?.callId === 'tool-1');
    expect(tool?.nativeId).toBe('tool-1');
    expect(
      envs.find((e) => e.type === 'tool_result' && e.toolResult?.callId === 'tool-1')?.toolResult,
    ).toEqual({ name: 'List files', callId: 'tool-1', result: 'file.txt', isError: false });
    expect(envs.some((e) => e.tool?.name === 'TodoWrite')).toBe(true);
    // Every message carries the agent-side ref the record keeps as nativeRef.
    expect(envs.filter((e) => e.type === 'assistant').every((e) => e.nativeId)).toBe(true);
    expect(envs.at(-1)).toEqual({ type: 'result', sessionId });
    // The chat's model was chosen on the agent, and Patch's tools went with the session.
    const reqs = requests();
    expect(reqs.find((r) => r.method === 'session/set_model')?.params.modelId).toBe('fake-flash');
    expect(reqs.find((r) => r.method === 'session/new')?.params.mcpServers).toEqual([
      {
        name: 'patch',
        command: 'node',
        args: ['mcp.js'],
        env: [{ name: 'PATCH_CHAT_ID', value: 'c1' }],
      },
    ]);
    // The history reader has the turn.
    expect(history.hasSession({ folder: cwd, sessionId })).toBe(true);
  }, 30_000);

  it('answers permission itself under bypass, and puts the agent in its own matching mode', async () => {
    const { backend, cwd } = setup();
    const envs = await collect(
      backend.run(
        opts({
          cwd,
          permissionMode: 'bypassPermissions',
          onPermissionRequest: async () => {
            throw new Error('should not ask');
          },
        }),
      ),
    );
    expect(said(envs).at(-1)).toBe('done:yes:fake-pro:yolo');
  }, 30_000);

  it('passes a refusal back to the agent', async () => {
    const { backend, cwd } = setup();
    const envs = await collect(
      backend.run(opts({ cwd, onPermissionRequest: async () => ({ approve: false }) })),
    );
    expect(said(envs).at(-1)).toBe('done:no:fake-pro:default');
    expect(envs.find((e) => e.toolResult?.callId === 'tool-1')?.toolResult?.isError).toBe(true);
  }, 30_000);

  it('continues its session on the next turn with the agent’s own load, recording nothing twice', async () => {
    const { backend, cwd, requests } = setup();
    const first = await collect(
      backend.run(opts({ cwd, onPermissionRequest: async () => ({ approve: true }) })),
    );
    const sessionId = first[0]!.sessionId!;
    const second = await collect(
      backend.run(opts({ cwd, prompt: 'echo', resumeSessionId: sessionId })),
    );
    expect(second[0]?.sessionId).toBe(sessionId);
    // The agent remembers; its replay of the conversation is not recorded again.
    expect(said(second)).toEqual(['heard:hello']);
    expect(requests().filter((r) => r.method === 'session/load')).toHaveLength(1);
  }, 30_000);

  it('cannot continue a session on an agent that cannot reopen one, and says so', async () => {
    const { backend, cwd } = setup({ FAKE_ACP_NO_LOAD: '1' });
    const first = await collect(
      backend.run(opts({ cwd, onPermissionRequest: async () => ({ approve: true }) })),
    );
    await expect(
      collect(backend.run(opts({ cwd, prompt: 'echo', resumeSessionId: first[0]!.sessionId! }))),
    ).rejects.toThrow(/cannot reopen a saved session/);
  }, 30_000);

  it('stops on a stop: the agent is told to cancel and the turn ends without a result', async () => {
    const { backend, cwd, requests } = setup();
    const abortController = new AbortController();
    const envs: SdkEnvelope[] = [];
    const run = (async () => {
      for await (const e of backend.run(opts({ cwd, prompt: 'slow', abortController }))) {
        envs.push(e);
        if (e.type === 'assistant_delta') abortController.abort();
      }
    })();
    await run;
    expect(envs.some((e) => e.type === 'result')).toBe(false);
    expect(requests().some((r) => r.method === 'session/cancel')).toBe(true);
  }, 30_000);

  it('fails loudly when the agent dies mid-turn, keeping what it said', async () => {
    const { backend, cwd } = setup();
    const envs: SdkEnvelope[] = [];
    const err = await (async () => {
      for await (const e of backend.run(opts({ cwd, prompt: 'crash' }))) envs.push(e);
    })().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TurnFailedError);
    expect((err as Error).message).toMatch(/^Fake ACP exited \(3\) before finishing the turn/);
    expect(said(envs)).toEqual(['about to crash']);
  }, 30_000);

  it('reports a quota refusal as a limit, and a missing key as signed out', async () => {
    const { backend, cwd, registry } = setup();
    const limit = await collect(backend.run(opts({ cwd, prompt: 'limit' }))).catch(
      (e: unknown) => e,
    );
    expect(limit).toBeInstanceOf(TurnFailedError);
    expect((limit as TurnFailedError).limit).toEqual({ kind: 'rate_limit', status: 'rejected' });
    expect(registry.accountState('fake')).toEqual({ state: 'limited' });

    const out = setup({ FAKE_ACP_NEED_KEY: '1' });
    const signedOut = await collect(out.backend.run(opts({ cwd: out.cwd }))).catch(
      (e: unknown) => e,
    );
    expect(signedOut).toBeInstanceOf(AcpSignedOutError);
    expect((signedOut as Error).message).toBe(
      'Fake ACP is not signed in on this host. Add its key under Settings → Providers, or sign in to it on this host.',
    );
    expect(out.registry.accountState('fake')).toEqual({ state: 'signed_out' });
  }, 30_000);

  it('refuses what ACP cannot do rather than pretending', async () => {
    const { backend, cwd } = setup();
    await expect(collect(backend.run(opts({ cwd, fork: { resumeAtUuid: null } })))).rejects.toThrow(
      /cannot branch/,
    );
    await expect(collect(backend.run(opts({ cwd, resumeSessionId: 'codex-abc' })))).rejects.toThrow(
      /Another provider's session/,
    );
    await expect(collect(backend.run(opts({ cwd, permissionMode: 'plan' })))).rejects.toThrow(
      /no plan mode/,
    );
    await expect(collect(backend.run(opts({ cwd, model: 'acp/nobody/x' })))).rejects.toThrow(
      /No ACP agent "nobody"/,
    );
  }, 30_000);
});

describe('a durable ACP turn', () => {
  it('keeps running through a host restart and is carried on, without repeats, by the next host', async () => {
    const { backend, cwd, config } = setup();
    const run = (
      attach: { consumed: any } | undefined,
      approve: () => Promise<{ approve: boolean }>,
    ) =>
      backend.run(
        opts({
          cwd,
          durableTurn: { config, chatId: 'c1', localId: 'L1', log, ...(attach ? { attach } : {}) },
          onPermissionRequest: approve,
        }),
      );
    const first: SdkEnvelope[] = [];
    let asked = false;
    const gen = run(undefined, async () => {
      asked = true;
      return new Promise(() => undefined); // the host goes away before the user answers
    })[Symbol.asyncIterator]();
    void (async () => {
      for (;;) {
        const n = await gen.next();
        if (n.done) return;
        first.push(n.value);
      }
    })();
    for (let i = 0; i < 400 && !asked; i++) await sleep(25);
    expect(asked).toBe(true);
    expect(said(first)).toEqual(['Hello there']);
    expect(inspectTurn(config, 'c1')?.state).toBe('live');

    // The host restarts: it lets go of the turn without ending it.
    expect(detachDurableTurns()).toBe(1);
    await sleep(100);
    const mid = inspectTurn(config, 'c1');
    expect(mid?.state).toBe('live');
    expect(mid?.consumed).not.toBeNull();

    resetDurableTurnsForTest();
    const second = await collect(run({ consumed: mid!.consumed }, async () => ({ approve: true })));
    // 'Hello there' was handled by the previous host; the unanswered permission
    // was asked again and answered; 'done:yes' can only come from the same agent.
    expect(said(second)).toEqual(['done:yes:fake-pro:default']);
    expect(second[0]).toEqual({ type: 'system', sessionId: first[0]!.sessionId });
    expect(second.at(-1)?.type).toBe('result');
  }, 60_000);
});

describe('a chat on an ACP model', () => {
  it('runs through the chat core: spawn, a turn, the record, and a second turn on the same session', async () => {
    const { backend, root, cwd } = setup();
    const events: WireEvent[] = [];
    const metaStore = createMetaStore(join(root, 'patch-home'));
    const known = new Set<string>();
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore,
      sdkBackend: {
        run: (o) => {
          const it = backend.run(o);
          return (async function* () {
            for await (const e of it) {
              if (e.sessionId) known.add(e.sessionId);
              yield e;
            }
          })();
        },
      },
      historyReader: {
        hasSession: (o: { sessionId: string }) => known.has(o.sessionId),
        read: () => [],
        forkPoint: () => null,
        sidePoint: () => null,
      } as any,
      claudeProjectsRoot: join(root, 'projects'),
      oauthAccessToken: 'tok',
      emit: (e) => events.push(e),
      logger: pino({ level: 'silent' }),
      now: () => 1_700_000_000_000,
      generateChatId: () => 'chat-1',
    });
    const chatId = await daemon.spawnChat({
      folder: cwd,
      model: 'acp/fake/fake-pro',
      permissionMode: 'bypassPermissions',
    } as any);
    await daemon.sendInput({ chatId, message: 'hello', localId: 'l1' });
    const messages = () =>
      events.flatMap((e) =>
        e.type === 'chat.message' && e.chatId === chatId && e.role === 'assistant'
          ? [e.content]
          : [],
      );
    expect(messages()).toEqual(['Hello there', 'done:yes:fake-pro:yolo']);
    const session = metaStore.read(chatId)!.claudeSessionId!;
    expect(session).toMatch(/^acp-fake-r-/);
    expect(events.some((e) => e.type === 'chat.tool_call' && (e as any).callId === 'tool-1')).toBe(
      true,
    );

    await daemon.sendInput({ chatId, message: 'echo', localId: 'l2' });
    expect(messages().at(-1)).toBe('heard:hello');
    expect(metaStore.read(chatId)!.claudeSessionId).toBe(session);
  }, 60_000);
});
