// ACP accounts (spec/10 § Account states, § Choosing an account, § Limits;
// decisions 24 and 25): an ACP agent with more than one account follows the
// shared account order and strategy, a chat can be locked to one account, and a
// turn the agent refuses with a limit runs again on the next account the chat
// may use. What the agent said about each account (a limit, a sign-in or key
// refusal, a turn completed) is reported to the server as this host's
// `host.account` for the ACP backend, and survives a host restart.

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { HostAccountEvent, LimitBehaviour, SharedAcpAccount, WireEvent } from '@patch/wire';
import { AcpBackend, AcpLimitError, AcpSignedOutError } from '../src/acpBackend.js';
import { AcpAccounts, type AcpRoute } from '../src/acpAccounts.js';
import { AcpRegistry } from '../src/acpRegistry.js';
import { CodexHistory } from '../src/codexHistory.js';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { harnessTraitsForModel } from '../src/harnesses.js';
import { fakeAgent } from './fixtures/acpFake.js';

const SPENT = 'spent-key-0000000000000000';
const GOOD = 'good-key-00000000000000000';
const BAD = 'bad-key-000000000000000000';
const account = (id: string, apiKey: string, agentId = 'fake'): SharedAcpAccount => ({
  id,
  agentId,
  label: id,
  apiKey,
});
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const priority: AcpRoute = { strategy: 'priority' };

describe('AcpAccounts', () => {
  it('orders an agent’s accounts by the shared strategy and skips a refused one', () => {
    const accounts = new AcpAccounts();
    accounts.apply([account('a1', 'k1'), account('a2', 'k2'), account('b1', 'k3', 'other')]);
    expect(accounts.resolve('fake', priority)?.id).toBe('a1');
    // Round-robin moves on only when a turn starts.
    expect(accounts.resolve('fake', { strategy: 'round-robin' }, true)?.id).toBe('a1');
    expect(accounts.resolve('fake', { strategy: 'round-robin' }, true)?.id).toBe('a2');
    expect(accounts.resolve('fake', { strategy: 'round-robin' })?.id).toBe('a1');

    expect(accounts.markLimited('a1', 'quota', priority)).toBe('a2');
    expect(accounts.resolve('fake', priority)?.id).toBe('a2');
    accounts.markSignedOut('a2', 'key refused');
    // Nothing left: the first is used anyway, so the turn fails with its own refusal.
    expect(accounts.markLimited('a1', 'quota', priority)).toBeUndefined();
    expect(accounts.resolve('fake', priority)?.id).toBe('a1');
    // Another agent's accounts are its own.
    expect(accounts.resolve('other', priority)?.id).toBe('b1');
    // A new key is a new chance.
    accounts.apply([account('a1', 'k1'), account('a2', 'k2-new'), account('b1', 'k3', 'other')]);
    expect(accounts.isSkipped('a2')).toBe(false);
    expect(accounts.resolve('fake', priority)?.id).toBe('a2');
  });

  it('a locked chat runs only on its account, and elsewhere while it is refused only under other_account', () => {
    const accounts = new AcpAccounts();
    accounts.apply([account('a1', 'k1'), account('a2', 'k2')]);
    expect(accounts.resolve('fake', { ...priority, preferred: 'a2' })?.id).toBe('a2');
    // Refused, locked, no other_account: nowhere else to go.
    expect(accounts.markLimited('a2', 'quota', { ...priority, preferred: 'a2' })).toBeUndefined();
    expect(accounts.resolve('fake', { ...priority, preferred: 'a2' })?.id).toBe('a2');
    // Continue on another account: this turn runs on a1; the lock is untouched.
    const anywhere = { ...priority, preferred: 'a2', resumeOnAnyAccount: true };
    expect(accounts.markLimited('a2', 'quota', anywhere)).toBe('a1');
    expect(accounts.resolve('fake', anywhere)?.id).toBe('a1');
    // A lock to an account the agent does not have is ignored.
    expect(accounts.resolve('fake', { ...priority, preferred: 'gone' })?.id).toBe('a1');
  });

  it('reports what the agent said about each account as facts for the server', () => {
    let now = 1_000;
    const accounts = new AcpAccounts({ now: () => now });
    accounts.apply([account('a1', 'k1'), account('a2', 'k2'), account('a3', 'k3')]);
    accounts.markLimited('a1', 'Fake ACP: 429 quota exceeded', priority);
    accounts.markSignedOut('a2', 'Fake ACP refused its API key');
    now = 2_000;
    accounts.noteWorked('a3');
    const report = accounts.report('h1', 'acp');
    expect(report).toMatchObject({ type: 'host.account', hostId: 'h1', backendId: 'acp' });
    expect(report.accounts).toEqual([
      {
        id: 'a1',
        label: 'a1',
        connected: true,
        kind: 'apiKey',
        refusal: { kind: 'limit', message: 'Fake ACP: 429 quota exceeded', at: 1_000 },
      },
      {
        id: 'a2',
        label: 'a2',
        connected: true,
        kind: 'apiKey',
        needsSignIn: true,
        error: 'Fake ACP refused its API key',
      },
      { id: 'a3', label: 'a3', connected: true, kind: 'apiKey', usage: { at: 2_000 } },
    ]);
    // A turn completed on a refused account: credit, reported as a reading taken then.
    now = 3_000;
    accounts.noteWorked('a1');
    expect(accounts.report('h1', 'acp').accounts?.[0]).toEqual({
      id: 'a1',
      label: 'a1',
      connected: true,
      kind: 'apiKey',
      usage: { at: 3_000 },
    });
    expect(accounts.isSkipped('a1')).toBe(false);
  });

  it('keeps its refusals across a restart, as Claude’s are kept', () => {
    let saved: Parameters<
      NonNullable<ConstructorParameters<typeof AcpAccounts>[0]>['onChange']
    >[0] = [];
    const first = new AcpAccounts({ onChange: (e) => (saved = e) });
    first.apply([account('a1', 'k1'), account('a2', 'k2')]);
    first.markLimited('a1', 'quota', priority);
    expect(saved.map((e) => e.accountId)).toEqual(['a1']);

    const second = new AcpAccounts({ initial: saved });
    second.apply([account('a1', 'k1'), account('a2', 'k2')]);
    expect(second.isSkipped('a1')).toBe(true);
    expect(second.resolve('fake', priority)?.id).toBe('a2');
    // Asked before the snapshot arrived: restored refusals still reach the rotation.
    const third = new AcpAccounts({ initial: saved });
    expect(third.resolve('fake', priority)).toBeUndefined();
    third.apply([account('a1', 'k1'), account('a2', 'k2')]);
    expect(third.resolve('fake', priority)?.id).toBe('a2');
  });

  it('a limit refused before any tool ran is safe to run again on another account', () => {
    const traits = harnessTraitsForModel('acp/fake/x');
    expect(traits.turnRetrySafe(new AcpLimitError('quota', true))).toBe(true);
    expect(traits.turnRetrySafe(new AcpLimitError('quota', false))).toBe(false);
  });
});

/** A chat on the fake agent, through the chat core and the real ACP adapter, wired as the host wires it. */
function setup(
  accountList: SharedAcpAccount[],
  opts: { limitBehaviour?: LimitBehaviour; preferred?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'acp-failover-'));
  const cwd = join(root, 'cwd');
  const state = join(root, 'agent-state');
  mkdirSync(cwd);
  mkdirSync(state);
  const agentLog = join(root, 'agent.log');
  const reports: HostAccountEvent[] = [];
  const accounts: AcpAccounts = new AcpAccounts({
    onChange: () => reports.push(accounts.report('d1', 'acp')),
  });
  accounts.apply(accountList);
  const behaviour = opts.limitBehaviour ?? 'resume_at_reset';
  const route = (preferred?: string): AcpRoute => ({
    strategy: 'priority',
    ...(preferred !== undefined ? { preferred } : {}),
    resumeOnAnyAccount: behaviour === 'other_account',
  });
  const registry = new AcpRegistry({
    providerKey: () => undefined,
    accountKey: (agentId, accountId) =>
      accountId !== undefined
        ? accounts.get(accountId)?.apiKey
        : accounts.resolve(agentId, route())?.apiKey,
    baseEnv: () => ({
      ...process.env,
      FAKE_ACP_STATE: state,
      FAKE_ACP_LOG: agentLog,
      FAKE_ACP_LIMIT_KEY: SPENT,
      FAKE_ACP_REJECT_KEY: BAD,
    }),
    scratchDir: join(root, 'scratch'),
    clientVersion: '1.0.0',
  });
  registry.setConfigured([fakeAgent({ apiKeyEnv: 'FAKE_ACP_KEY' })]);
  const backend = new AcpBackend(
    registry,
    new CodexHistory(join(root, 'history'), 'acp'),
    '1.0.0',
    {
      signedOut: (id, reason) => accounts.markSignedOut(id, reason),
      worked: (id) => accounts.noteWorked(id),
    },
  );
  const known = new Set<string>();
  const events: WireEvent[] = [];
  const ranOn: Array<string | undefined> = [];
  const daemon: Daemon = new Daemon({
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
    historyReader: {
      hasSession: (o: { sessionId: string }) => known.has(o.sessionId),
      read: () => [],
      forkPoint: () => null,
      sidePoint: () => null,
    } as any,
    claudeProjectsRoot: join(root, 'projects'),
    resolveOAuth: async (_model, turn) => {
      const a = accounts.resolve('fake', route(turn?.preferredAccountId), turn !== undefined);
      return { ok: true as const, accessToken: '', ...(a ? { accountId: a.id } : {}) };
    },
    nextAccountAfterExhausted: (chatId, id, message) =>
      id !== undefined
        ? accounts.markLimited(id, message, route(daemon.chatState.get(chatId)?.preferredAccountId))
        : undefined,
    accountLabel: (_model, id) => accounts.get(id)?.label,
    emit: (e) => events.push(e),
    logger: pino({ level: 'silent' }),
    now: () => 1_700_000_000_000,
    generateChatId: () => 'chat-1',
  });
  daemon.setLimitBehaviour(behaviour);
  const spawn = async (): Promise<string> => {
    const chatId = await daemon.spawnChat({
      folder: cwd,
      model: 'acp/fake/fake-pro',
      permissionMode: 'bypassPermissions',
    } as any);
    if (opts.preferred !== undefined) daemon.setChatPreferredAccount(chatId, opts.preferred);
    return chatId;
  };
  const replies = (chatId: string) =>
    events.flatMap((e) =>
      e.type === 'chat.message' && e.chatId === chatId && e.role === 'assistant' ? [e.content] : [],
    );
  const errors = (chatId: string) =>
    events.flatMap((e) =>
      e.type === 'chat.error' && e.chatId === chatId ? [e.error.message] : [],
    );
  const prompts = () =>
    readFileSync(agentLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.method === 'session/prompt').length;
  const settle = async (done: () => boolean): Promise<void> => {
    for (let i = 0; i < 400 && !done(); i++) await sleep(25);
  };
  return { daemon, accounts, reports, ranOn, spawn, replies, errors, prompts, settle };
}

describe('a chat on an ACP agent with two accounts', () => {
  it('continues on the second account when the first hits a limit, and reports the limit', async () => {
    const t = setup([account('first', SPENT), account('second', GOOD)]);
    const chatId = await t.spawn();
    await t.daemon.sendInput({ chatId, message: 'echo', localId: 'l1' });
    // The re-run is started by the failover, not awaited by the first send.
    await t.settle(() => t.replies(chatId).length > 0);
    expect(t.ranOn).toEqual(['first', 'second']);
    expect(t.replies(chatId)).toEqual(['heard:']);
    expect(t.prompts()).toBe(2);
    expect(t.accounts.isSkipped('first')).toBe(true);
    // The server is told: the first refused with a limit, the second worked.
    const last = t.reports.at(-1)!;
    expect(last.accounts?.find((a) => a.id === 'first')?.refusal).toMatchObject({ kind: 'limit' });
    expect(last.accounts?.find((a) => a.id === 'second')?.usage?.at).toBeTypeOf('number');
    // The next turn starts straight on the second account.
    await t.daemon.sendInput({ chatId, message: 'echo', localId: 'l2' });
    expect(t.ranOn.at(-1)).toBe('second');
    t.daemon.shutdown();
  }, 60_000);

  it('a chat locked to an account runs on it, and waits on it when it is refused', async () => {
    const t = setup([account('first', GOOD), account('second', SPENT)], {
      preferred: 'second',
      limitBehaviour: 'switch_provider',
    });
    const chatId = await t.spawn();
    await t.daemon.sendInput({ chatId, message: 'echo', localId: 'l1' });
    await t.settle(() => t.errors(chatId).length > 0);
    // Locked, and the user did not choose another account: no move to `first`.
    expect(t.ranOn).toEqual(['second']);
    expect(t.replies(chatId)).toEqual([]);
    t.daemon.shutdown();
  }, 60_000);

  it('a locked chat continues on another account while its own is refused, under other_account', async () => {
    const t = setup([account('first', GOOD), account('second', SPENT)], {
      preferred: 'second',
      limitBehaviour: 'other_account',
    });
    const chatId = await t.spawn();
    await t.daemon.sendInput({ chatId, message: 'echo', localId: 'l1' });
    await t.settle(() => t.replies(chatId).length > 0);
    expect(t.ranOn).toEqual(['second', 'first']);
    expect(t.replies(chatId)).toEqual(['heard:']);
    t.daemon.shutdown();
  }, 60_000);

  it('a key the provider rejects is signed out: skipped, and reported as needing a sign-in', async () => {
    const t = setup([account('bad', BAD), account('good', GOOD)]);
    const chatId = await t.spawn();
    await t.daemon.sendInput({ chatId, message: 'echo', localId: 'l1' });
    await t.settle(() => t.reports.some((r) => r.accounts?.some((a) => a.needsSignIn)));
    expect(t.ranOn).toEqual(['bad']);
    expect(t.accounts.isSkipped('bad')).toBe(true);
    const bad = t.reports.at(-1)!.accounts?.find((a) => a.id === 'bad');
    expect(bad).toMatchObject({ needsSignIn: true });
    expect(bad?.error).toMatch(/refused its API key: API key not valid/);
    // The next turn skips it.
    await t.daemon.sendInput({ chatId, message: 'echo', localId: 'l2' });
    expect(t.ranOn.at(-1)).toBe('good');
    expect(t.replies(chatId).at(-1)).toMatch(/^heard:/);
    t.daemon.shutdown();
  }, 60_000);

  it('names the key refusal as a sign-in error of its own', () => {
    expect(new AcpSignedOutError('Fake ACP', 'API key not valid').message).toBe(
      'Fake ACP refused its API key: API key not valid. Replace the key under Settings → AI accounts.',
    );
  });
});
