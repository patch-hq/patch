// ACP account failover (spec/10 § Limits, decision 25): an ACP agent with more
// than one account follows the shared account order and strategy, and a turn the
// agent refuses with a limit on one account runs again on the next, through the
// host's chat core and the real ACP adapter driving the fake agent. An account
// the agent refused as limited or signed out is skipped.

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { SharedAcpAccount, WireEvent } from '@patch/wire';
import { AcpBackend, AcpLimitError } from '../src/acpBackend.js';
import { AcpAccounts } from '../src/acpAccounts.js';
import { AcpRegistry } from '../src/acpRegistry.js';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { harnessTraitsForModel } from '../src/harnesses.js';
import { fakeAgent } from './fixtures/acpFake.js';

const SPENT = 'spent-key-0000000000000000';
const GOOD = 'good-key-00000000000000000';
const account = (id: string, apiKey: string): SharedAcpAccount => ({
  id,
  agentId: 'fake',
  label: id,
  apiKey,
});
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('AcpAccounts', () => {
  it('orders an agent’s accounts by the shared strategy and skips a refused one', () => {
    const accounts = new AcpAccounts();
    accounts.apply([
      account('a1', 'k1'),
      account('a2', 'k2'),
      { ...account('b1', 'k3'), agentId: 'other' },
    ]);
    expect(accounts.resolve('fake', { strategy: 'priority' })?.id).toBe('a1');
    // Round-robin moves on only when a turn starts.
    expect(accounts.resolve('fake', { strategy: 'round-robin' }, true)?.id).toBe('a1');
    expect(accounts.resolve('fake', { strategy: 'round-robin' }, true)?.id).toBe('a2');
    expect(accounts.resolve('fake', { strategy: 'round-robin' })?.id).toBe('a1');

    expect(accounts.markLimited('a1', 'quota', { strategy: 'priority' })).toBe('a2');
    expect(accounts.resolve('fake', { strategy: 'priority' })?.id).toBe('a2');
    accounts.markSignedOut('a2');
    // Nothing left: the first is used anyway, so the turn fails with its own refusal.
    expect(accounts.markLimited('a1', 'quota', { strategy: 'priority' })).toBeUndefined();
    expect(accounts.resolve('fake', { strategy: 'priority' })?.id).toBe('a1');
    // Another agent's accounts are its own.
    expect(accounts.resolve('other', { strategy: 'priority' })?.id).toBe('b1');
    // A new key is a new chance.
    accounts.apply([
      account('a1', 'k1'),
      account('a2', 'k2-new'),
      { ...account('b1', 'k3'), agentId: 'other' },
    ]);
    expect(accounts.isSkipped('a2')).toBe(false);
    expect(accounts.resolve('fake', { strategy: 'priority' })?.id).toBe('a2');
  });

  it('a limit refused before any tool ran is safe to run again on another account', () => {
    const traits = harnessTraitsForModel('acp/fake/x');
    expect(traits.turnRetrySafe(new AcpLimitError('quota', true))).toBe(true);
    expect(traits.turnRetrySafe(new AcpLimitError('quota', false))).toBe(false);
  });
});

describe('a chat on an ACP agent with two accounts', () => {
  it('continues on the second account when the first hits a limit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acp-failover-'));
    const cwd = join(root, 'cwd');
    const state = join(root, 'agent-state');
    mkdirSync(cwd);
    mkdirSync(state);
    const agentLog = join(root, 'agent.log');
    const accounts = new AcpAccounts();
    accounts.apply([account('first', SPENT), account('second', GOOD)]);
    const route = { strategy: 'priority' as const };
    const registry = new AcpRegistry({
      providerKey: () => undefined,
      accountKey: (agentId, accountId) =>
        accountId !== undefined
          ? accounts.get(accountId)?.apiKey
          : accounts.resolve(agentId, route)?.apiKey,
      baseEnv: () => ({
        ...process.env,
        FAKE_ACP_STATE: state,
        FAKE_ACP_LOG: agentLog,
        FAKE_ACP_LIMIT_KEY: SPENT,
      }),
      scratchDir: join(root, 'scratch'),
      clientVersion: '1.0.0',
    });
    registry.setConfigured([fakeAgent({ apiKeyEnv: 'FAKE_ACP_KEY' })]);
    const backend = new AcpBackend(registry, '1.0.0');
    const known = new Set<string>();
    const events: WireEvent[] = [];
    const ranOn: Array<string | undefined> = [];
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(join(root, 'patch-home')),
      sdkBackend: {
        run: (o) => {
          ranOn.push(o.accountId);
          const it = backend.run(o);
          return (async function* () {
            for await (const e of it) {
              if (e.sessionId) known.add(e.sessionId);
              yield e;
            }
          })();
        },
      },
      sessionProbe: { hasSession: (o: { sessionId: string }) => known.has(o.sessionId) },
      claudeProjectsRoot: join(root, 'projects'),
      resolveOAuth: async (_model, turn) => {
        const a = accounts.resolve('fake', route, turn !== undefined);
        return { ok: true as const, accessToken: '', ...(a ? { accountId: a.id } : {}) };
      },
      nextAccountAfterExhausted: (_chatId, id, message) =>
        id !== undefined ? accounts.markLimited(id, message, route) : undefined,
      emit: (e) => events.push(e),
      logger: pino({ level: 'silent' }),
      now: () => 1_700_000_000_000,
      generateChatId: () => 'chat-1',
    });
    daemon.setLimitBehaviour('other_account');
    const chatId = await daemon.spawnChat({
      folder: cwd,
      model: 'acp/fake/fake-pro',
      permissionMode: 'bypassPermissions',
    } as any);
    await daemon.sendInput({ chatId, message: 'echo', localId: 'l1' });
    const replies = () =>
      events.flatMap((e) =>
        e.type === 'chat.message' && e.chatId === chatId && e.role === 'assistant'
          ? [e.content]
          : [],
      );
    // The re-run is started by the failover, not awaited by the first send.
    for (let i = 0; i < 400 && replies().length === 0; i++) await sleep(25);
    expect(ranOn).toEqual(['first', 'second']);
    expect(replies()).toEqual(['heard:']);
    expect(accounts.isSkipped('first')).toBe(true);
    // Two prompts reached the agent: refused on the spent key, answered on the good one.
    const prompts = readFileSync(agentLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.method === 'session/prompt').length;
    expect(prompts).toBe(2);
    // The next turn starts straight on the second account.
    await daemon.sendInput({ chatId, message: 'echo', localId: 'l2' });
    expect(ranOn.at(-1)).toBe('second');
    daemon.shutdown();
  }, 60_000);
});
