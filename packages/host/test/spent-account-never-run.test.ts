// spec/10 § Choosing an account, § Limits — a turn never starts on an account
// already known to have no credit. There is nothing to learn from it: the
// provider refuses it, a model process is started for nothing, and on the host
// that reported it (2026-11-23) chats that had just failed on a signed-out
// Bedrock profile were moved straight onto subscriptions already sidelined as
// limited, each failing again before parking. When nothing usable is left the
// turn pauses as a limit with the earliest reset, without asking any model.

import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import type { WireEvent } from '@patch/wire';
import { AccountRotation, spentRefusal, type FailoverAccount } from '../src/accountFailover.js';
import { Daemon, type OAuthCheckResult } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend, SdkEnvelope } from '../src/sdkBackend.js';

const NOW = Date.UTC(2026, 10, 23, 15);
const HOUR = 3_600_000;

describe('routing never hands out a known-limited account', () => {
  const subs: FailoverAccount[] = [
    { id: 'a', connected: true },
    { id: 'b', connected: true },
  ];

  it('with every account spent there is nowhere to run, and the turn is told the earliest reset', () => {
    const r = new AccountRotation(() => NOW);
    r.markExhausted('a', 'weekly limit', NOW + 5 * HOUR);
    r.markExhausted('b', 'session limit', NOW + 2 * HOUR);
    expect(r.effectiveAccount(subs)).toBeUndefined();
    expect(r.startTurn(subs)).toBeUndefined();
    const spent = r.spentInRoute(subs);
    expect(spent.map((s) => s.accountId)).toEqual(['a', 'b']);
    expect(Math.min(...spent.map((s) => s.resetsAt!))).toBe(NOW + 2 * HOUR);
  });

  it('a signed-out Bedrock account and spent subscriptions: nothing runs, and the subscriptions are what it waits on', () => {
    const r = new AccountRotation(() => NOW);
    const accounts: FailoverAccount[] = [{ id: 'bed', connected: false }, ...subs];
    r.markExhausted('a', 'weekly limit', NOW + 5 * HOUR);
    r.markExhausted('b', 'weekly limit', NOW + 13 * HOUR);
    expect(r.startTurn(accounts)).toBeUndefined();
    expect(r.spentInRoute(accounts).map((s) => s.accountId)).toEqual(['a', 'b']);
    // A chat locked to the Bedrock account that may continue elsewhere: still
    // nowhere, because the elsewhere is spent.
    const locked = { preferred: 'bed', resumeOnAnyAccount: true };
    expect(r.startTurn(accounts, locked)).toBeUndefined();
  });

  it('failover skips a spent account and lands on the one with credit', () => {
    const r = new AccountRotation(() => NOW);
    const three: FailoverAccount[] = [...subs, { id: 'c', connected: true }];
    r.markExhausted('a', 'limit', NOW + HOUR);
    r.markExhausted('b', 'limit', NOW + HOUR);
    expect(r.usableAccount(three)).toBe('c');
    expect(r.startTurn(three)).toBe('c');
  });

  it('an account a usage reading says is at its limit is skipped before any turn is refused on it', () => {
    const r = new AccountRotation(() => NOW);
    const accounts: FailoverAccount[] = [
      { id: 'a', connected: true, limited: { resetsAt: NOW + 3 * HOUR } },
      { id: 'b', connected: true },
    ];
    expect(r.startTurn(accounts)).toBe('b');
    expect(r.usableAccounts(accounts)).toEqual(['b']);
    // Locked to it with other_account: moves off it.
    expect(r.startTurn(accounts, { preferred: 'a', resumeOnAnyAccount: true })).toBe('b');
    // Locked to it, and may not move: waits on it, with its reset.
    expect(r.startTurn(accounts, { preferred: 'a' })).toBeUndefined();
    expect(r.spentInRoute(accounts, { preferred: 'a' })).toEqual([
      { accountId: 'a', capped: false, kind: 'limit', resetsAt: NOW + 3 * HOUR },
    ]);
  });

  it('unknown usage is not a limit: an account with no reading is still used', () => {
    const r = new AccountRotation(() => NOW);
    expect(r.startTurn([{ id: 'unread', connected: true }])).toBe('unread');
  });

  it('says which account it waits on and when it returns', () => {
    expect(spentRefusal('Work', 'limit', Date.UTC(2026, 10, 23, 17, 30))).toBe(
      'No account this chat may use has credit. Work is limited until 2026-11-23T17:30:00Z.',
    );
    expect(spentRefusal('Work', 'out', undefined)).toContain('Work is out of credit');
  });
});

describe('a turn with nowhere to run does not start', () => {
  function setup(credential: OAuthCheckResult) {
    const home = mkdtempSync(join(tmpdir(), 'patch-spent-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-spent-folder-')));
    const events: WireEvent[] = [];
    const calls = { n: 0 };
    const backend: SdkBackend = {
      run: (): AsyncGenerator<SdkEnvelope> => {
        calls.n += 1;
        async function* gen(): AsyncGenerator<SdkEnvelope> {
          yield { type: 'result', sessionId: 's', content: 'done', raw: {} };
        }
        return gen();
      },
    };
    const asked: Array<string | undefined> = [];
    let id = 0;
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: backend,
      resolveOAuth: () => credential,
      nextAccountAfterExhausted: (_chatId, spent) => {
        asked.push(spent);
        return undefined;
      },
      hostOutOfCredit: () => true,
      emit: (e) => events.push(e),
      logger: pino({ level: 'silent' }),
      now: () => NOW,
      generateChatId: () => `chat-${++id}`,
    });
    return { daemon, events, folder, calls, asked };
  }

  it('every account spent: parked as a limit until the earliest reset, and no model is asked', async () => {
    const resetsAt = NOW + 2 * HOUR;
    const { daemon, events, folder, calls, asked } = setup({
      ok: false,
      reason: spentRefusal('B', 'limit', resetsAt),
      limit: { accountId: 'b', resetsAt },
    });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    expect(calls.n).toBe(0);
    // The limit is blamed on the account it waits on.
    expect(asked).toEqual(['b']);
    expect(daemon.chatState.get(chatId)?.activity).not.toBe('running');
    const block = events
      .filter((e) => e.type === 'chat.state' && e.chatId === chatId)
      .map((e) => (e as { limitBlock?: { accountId?: string; resetsAt?: number } }).limitBlock)
      .filter((b) => b !== undefined)
      .at(-1);
    expect(block?.accountId).toBe('b');
    expect(block?.resetsAt).toBe(resetsAt);
  });

  it('out of credit with no reset: stopped, no timer, and no model is asked', async () => {
    const { daemon, folder, calls } = setup({
      ok: false,
      reason: spentRefusal('A', 'out', undefined),
      limit: { accountId: 'a', kind: 'out' },
    });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    expect(calls.n).toBe(0);
    const state = daemon.chatState.get(chatId);
    expect(state?.activity).not.toBe('running');
    expect(state?.rateLimitResumingAt).toBeUndefined();
  });
});
