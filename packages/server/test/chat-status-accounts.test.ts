// Paused, waiting for sign-in and out of credit come from the state of the
// account a chat's turn ran on (spec/12 § Limits and sign-in, spec/10 § Account
// states). The host says only that its turn ended on a limit, with the
// provider's words and reset; the server reads the account.

import { describe, test, expect } from 'vitest';
import type { AccountState, ChatStateEvent, TurnLimit, WireEvent } from '@patch/wire';
import {
  deriveStatus,
  emptyFacts,
  restoredFacts,
  type ChatStatusFacts,
} from '../src/chat-status.js';
import { ChatRegistry } from '../src/chat-registry.js';

const facts = (over: Partial<ChatStatusFacts>): ChatStatusFacts => ({ ...emptyFacts(), ...over });
const lookup =
  (states: Record<string, AccountState>) =>
  (id: string): AccountState | undefined =>
    states[id];

describe('deriveStatus with account states', () => {
  const limited = facts({
    limit: { reason: 'session', resetsAt: 500, accountId: 'a', message: 'limit reached' },
    limitHeld: true,
  });

  test('a limit the account confirms pauses until the account says it resets', () => {
    expect(deriveStatus(limited, false, lookup({ a: { state: 'limited', until: 900 } }))).toEqual({
      state: 'paused',
      reason: 'session',
      resetsAt: 900,
      message: 'limit reached',
      accountId: 'a',
    });
  });

  test('a signed-out account waits for sign-in, whatever the limit said', () => {
    expect(deriveStatus(limited, false, lookup({ a: { state: 'signed_out' } }))).toEqual({
      state: 'waiting_for_sign_in',
      reason: 'signed_out',
      accountId: 'a',
    });
  });

  test('an account out of credit stops with that reason and the provider words', () => {
    expect(
      deriveStatus(limited, false, lookup({ a: { state: 'out', message: 'no credit' } })),
    ).toEqual({ state: 'failed', reason: 'out_of_credit', message: 'no credit', accountId: 'a' });
  });

  test('a broken account fails with its message', () => {
    expect(
      deriveStatus(limited, false, lookup({ a: { state: 'broken', message: 'bad org' } })),
    ).toMatchObject({ state: 'failed', reason: 'account_broken', message: 'bad org' });
  });

  test('credit back leaves the owed turn paused until it runs or the user continues it', () => {
    expect(deriveStatus(limited, false, lookup({ a: { state: 'ready' } }))).toMatchObject({
      state: 'paused',
      resetsAt: 500,
    });
  });

  test('a limit no one states a reset for stops as a limit, never as out of credit', () => {
    const noReset = facts({
      limit: { reason: 'unknown', accountId: 'a', message: 'Quota exceeded' },
      limitHeld: true,
    });
    expect(deriveStatus(noReset, false, lookup({ a: { state: 'limited' } }))).toEqual({
      state: 'failed',
      reason: 'limit_no_reset',
      message: 'Quota exceeded',
      accountId: 'a',
    });
    // An account the server does not hold: the fact alone.
    expect(deriveStatus(noReset)).toMatchObject({ state: 'failed', reason: 'limit_no_reset' });
    expect(deriveStatus(limited)).toMatchObject({ state: 'paused', resetsAt: 500 });
  });

  test('a limit the host no longer holds is not a pause', () => {
    expect(deriveStatus({ ...limited, limitHeld: false }).state).toBe('idle');
  });

  test('facts saved before the host held flag was kept still pause on their limit', () => {
    expect(restoredFacts({ limit: { reason: 'session', resetsAt: 5 } }).limitHeld).toBe(true);
    expect(restoredFacts({ limit: null }).limitHeld).toBe(false);
  });

  test('the account of the latest turn stands in when the limit names none', () => {
    const f = facts({ accountId: 'a', limit: { reason: 'week', resetsAt: 5 }, limitHeld: true });
    expect(deriveStatus(f, false, lookup({ a: { state: 'signed_out' } }))).toMatchObject({
      state: 'waiting_for_sign_in',
      accountId: 'a',
    });
  });

  test('a failed turn on a signed-out or spent account stops and asks', () => {
    const failed = facts({
      accountId: 'a',
      lastEnd: { outcome: 'failed', error: { code: 'sdk_error', message: '401' } },
    });
    expect(deriveStatus(failed, false, lookup({ a: { state: 'signed_out' } }))).toMatchObject({
      state: 'waiting_for_sign_in',
      accountId: 'a',
    });
    expect(
      deriveStatus(failed, false, lookup({ a: { state: 'out', message: 'top up' } })),
    ).toMatchObject({ state: 'failed', reason: 'out_of_credit', message: 'top up' });
    expect(deriveStatus(failed, false, lookup({ a: { state: 'ready' } }))).toMatchObject({
      state: 'failed',
      reason: 'sdk_error',
    });
  });

  test('a sign-in failure reads idle once its account is signed in again', () => {
    const f = facts({
      accountId: 'a',
      lastEnd: { outcome: 'failed', error: { code: 'claude_oauth_missing', message: 'm' } },
    });
    expect(deriveStatus(f, false, lookup({ a: { state: 'signed_out' } })).state).toBe(
      'waiting_for_sign_in',
    );
    expect(deriveStatus(f, false, lookup({ a: { state: 'ready' } })).state).toBe('idle');
    // A host whose account the server cannot name keeps the code's word.
    expect(deriveStatus({ ...f, accountId: null }).state).toBe('waiting_for_sign_in');
  });
});

describe('ChatRegistry: limits from a host that reports them as facts', () => {
  const spawned: WireEvent = { type: 'chat.spawned', chatId: 'c1', hostId: 'h1', folder: '/w' };
  const state = (over: Partial<ChatStateEvent> = {}): ChatStateEvent =>
    ({
      type: 'chat.state',
      chatId: 'c1',
      hostId: 'h1',
      permissionMode: 'auto',
      lastUpdated: 1,
      account: { id: 'a', label: 'Work' },
      ...over,
    }) as ChatStateEvent;
  const started = (turnId: string): WireEvent => ({
    type: 'chat.turn_started',
    chatId: 'c1',
    turnId,
    seq: -1,
    at: 1,
  });
  const endedOnLimit = (turnId: string, limit: TurnLimit): WireEvent => ({
    type: 'chat.turn_ended',
    chatId: 'c1',
    turnId,
    seq: -1,
    at: 2,
    outcome: 'failed',
    error: { code: 'sdk_error', message: 'Session limit · Work' },
    limit,
  });
  const limitA: TurnLimit = { accountId: 'a', scope: 'session', resetsAt: 500, message: 'hit' };

  const make = (opts: { limitFacts?: boolean } = {}) => {
    const states: Record<string, AccountState> = { a: { state: 'limited', until: 500 } };
    const reg = new ChatRegistry({ now: () => 100 });
    reg.setAccounts({
      state: (id) => states[id],
      hostLimitFacts: () => opts.limitFacts ?? true,
    });
    const told: ChatStateEvent[] = [];
    reg.onStatusChange((e) => told.push(e));
    reg.observe(spawned);
    return { reg, states, told };
  };

  /** The host parks the turn (its frame says it holds it), then ends it on the limit. */
  const pauseOnLimit = (reg: ChatRegistry, next: ChatStateEvent['limitNext']) => {
    reg.observe(started('t1'));
    reg.observe(state({ limitNext: next }));
    reg.observe(endedOnLimit('t1', limitA));
  };

  test('resume at reset: paused with the reset, then running when the host runs the owed turn', () => {
    const { reg } = make();
    pauseOnLimit(reg, 'resume_at_reset');
    expect(reg.get('c1')?.chatStatus).toMatchObject({
      state: 'paused',
      reason: 'session',
      resetsAt: 500,
      accountId: 'a',
    });
    // The reset passes: the host releases the turn and it starts.
    reg.observe(state({ limitNext: null }));
    reg.observe(started('t2'));
    expect(reg.get('c1')?.chatStatus?.state).toBe('running');
    expect(reg.factsOf('c1')?.limit).toBeNull();
  });

  test('another account: the owed turn runs on the next account and the chat is running', () => {
    const { reg } = make();
    pauseOnLimit(reg, 'other_account');
    expect(reg.get('c1')?.chatStatus?.state).toBe('paused');
    reg.observe(state({ limitNext: null, account: { id: 'b', label: 'Home' } }));
    reg.observe(started('t2'));
    expect(reg.get('c1')?.chatStatus?.state).toBe('running');
    expect(reg.factsOf('c1')?.accountId).toBe('b');
  });

  test('switch provider: stays paused with credit back until the user switches, then idle', () => {
    const { reg, states } = make();
    pauseOnLimit(reg, 'switch_provider');
    states['a'] = { state: 'ready' };
    reg.accountStatesChanged();
    expect(reg.get('c1')?.chatStatus?.state).toBe('paused');
    // The user switched provider: the new linked chat carries on, this one owes nothing.
    reg.observe(state({ limitNext: null }));
    expect(reg.get('c1')?.chatStatus?.state).toBe('idle');
  });

  test('signed out while paused: waits for sign-in, and pauses again once signed in', () => {
    const { reg, states, told } = make();
    pauseOnLimit(reg, 'resume_at_reset');
    told.length = 0;
    states['a'] = { state: 'signed_out' };
    reg.accountStatesChanged();
    expect(reg.get('c1')?.chatStatus).toMatchObject({
      state: 'waiting_for_sign_in',
      accountId: 'a',
    });
    expect(told.map((e) => e.chatStatus?.state)).toEqual(['waiting_for_sign_in']);
    states['a'] = { state: 'limited', until: 500 };
    reg.accountStatesChanged();
    expect(reg.get('c1')?.chatStatus?.state).toBe('paused');
  });

  test('out of credit stops and asks: failed with the reason, never running on its own', () => {
    const { reg, states } = make();
    states['a'] = { state: 'out', message: 'Your credit balance is too low' };
    reg.observe(started('t1'));
    reg.observe(state({ limitNext: 'ask' }));
    reg.observe(
      endedOnLimit('t1', { accountId: 'a', scope: 'unknown', message: 'credit balance too low' }),
    );
    expect(reg.get('c1')?.chatStatus).toMatchObject({
      state: 'failed',
      reason: 'out_of_credit',
      message: 'Your credit balance is too low',
    });
    // Credit is seen: the turn is still owed and waits for Continue.
    states['a'] = { state: 'ready' };
    reg.accountStatesChanged();
    expect(reg.get('c1')?.chatStatus?.state).toBe('paused');
    expect(reg.factsOf('c1')?.openTurns).toEqual([]);
  });

  test('a limit with no reset stops as a limit with the provider words, not as out of credit', () => {
    const { reg, states } = make();
    states['a'] = { state: 'ready' };
    reg.observe(started('t1'));
    reg.observe(state({ limitNext: 'ask' }));
    reg.observe(endedOnLimit('t1', { accountId: 'a', scope: 'unknown', message: 'Quota hit' }));
    // Credit on the account, but nothing stated when the limit lifts: still paused for Continue.
    expect(reg.get('c1')?.chatStatus?.state).toBe('paused');
    states['a'] = { state: 'limited' };
    reg.accountStatesChanged();
    expect(reg.get('c1')?.chatStatus).toMatchObject({
      state: 'failed',
      reason: 'limit_no_reset',
      message: 'Quota hit',
    });
  });

  test('provider switch: a limit fact that arrives after the host let the turn go never pauses', () => {
    const { reg } = make();
    reg.observe(started('t1'));
    reg.observe(state({ limitNext: 'switch_provider' }));
    // The user switched provider before the turn's end reached the server.
    reg.observe(state({ limitNext: null }));
    reg.observe(endedOnLimit('t1', limitA));
    expect(reg.get('c1')?.chatStatus?.state).toBe('idle');
    // And stays so as account states move: the old chat runs no other turn.
    reg.accountStatesChanged();
    expect(reg.get('c1')?.chatStatus?.state).toBe('idle');
  });

  test('resume: a limit fact that arrives after the release is overtaken by the next turn', () => {
    const { reg } = make();
    reg.observe(started('t1'));
    reg.observe(state({ limitNext: 'resume_at_reset' }));
    reg.observe(state({ limitNext: null }));
    reg.observe(endedOnLimit('t1', limitA));
    expect(reg.get('c1')?.chatStatus?.state).toBe('idle');
    reg.observe(started('t2'));
    expect(reg.get('c1')?.chatStatus?.state).toBe('running');
  });

  test('a limit fact that arrives before the frame saying the host holds it pauses once it does', () => {
    const { reg } = make();
    reg.observe(started('t1'));
    reg.observe(endedOnLimit('t1', limitA));
    reg.observe(state({ limitNext: 'resume_at_reset' }));
    expect(reg.get('c1')?.chatStatus).toMatchObject({ state: 'paused', resetsAt: 500 });
    reg.observe(state({ limitNext: null }));
    expect(reg.get('c1')?.chatStatus?.state).toBe('idle');
  });

  test('a limitBlock on its own does not pause a chat whose host reports limits as facts', () => {
    const { reg } = make();
    reg.observe(started('t1'));
    reg.observe(
      state({ limitBlock: { scope: 'session', resetsAt: 500 } as ChatStateEvent['limitBlock'] }),
    );
    expect(reg.get('c1')?.chatStatus?.state).toBe('running');
  });

  test('an overload backoff is a transient retry: running, not paused', () => {
    const { reg } = make();
    reg.observe(started('t1'));
    reg.observe({
      type: 'chat.turn_ended',
      chatId: 'c1',
      turnId: 't1',
      seq: -1,
      at: 2,
      outcome: 'failed',
    } as WireEvent);
    reg.observe(state({ rateLimitResumingAt: 900, resumeKind: 'overloaded' }));
    expect(reg.get('c1')?.chatStatus?.state).toBe('running');
  });

  test('an older host: its limitBlock is the limit, and the account still decides', () => {
    const { reg, states } = make({ limitFacts: false });
    reg.observe(started('t1'));
    reg.observe({
      type: 'chat.turn_ended',
      chatId: 'c1',
      turnId: 't1',
      seq: -1,
      at: 2,
      outcome: 'failed',
    } as WireEvent);
    reg.observe(
      state({
        limitBlock: {
          scope: 'week',
          resetsAt: 700,
          accountId: 'a',
        } as ChatStateEvent['limitBlock'],
      }),
    );
    expect(reg.get('c1')?.chatStatus).toMatchObject({ state: 'paused', reason: 'week' });
    states['a'] = { state: 'signed_out' };
    reg.accountStatesChanged();
    expect(reg.get('c1')?.chatStatus?.state).toBe('waiting_for_sign_in');
    // Its block cleared with no turn starting: nothing is owed, the chat is at rest.
    states['a'] = { state: 'ready' };
    reg.observe(state({ limitBlock: null }));
    expect(reg.get('c1')?.chatStatus?.state).toBe('idle');
  });
});
