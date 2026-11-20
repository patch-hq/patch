// A chat's status, decided by the server alone from the facts hosts report
// (spec/12 § Chat status). A host never sends a status or an activity.

import { describe, test, expect } from 'vitest';
import pino from 'pino';
import type { ChatStateEvent, WireEvent } from '@patch/wire';
import {
  deriveStatus,
  emptyFacts,
  factsFromHostState,
  factsOnRequestRaised,
  factsOnRequestResolved,
  factsOnTurnEnded,
  factsOnTurnStarted,
  isAllowedTransition,
  legacyActivity,
  nextStatus,
  type ChatStatusFacts,
} from '../src/chat-status.js';
import { ChatRegistry } from '../src/chat-registry.js';

const state = (over: Partial<ChatStateEvent> = {}): ChatStateEvent =>
  ({
    type: 'chat.state',
    chatId: 'c1',
    hostId: 'h1',
    permissionMode: 'auto',
    lastUpdated: 1,
    ...over,
  }) as ChatStateEvent;

const started = (chatId = 'c1', turnId = 't1'): WireEvent => ({
  type: 'chat.turn_started',
  chatId,
  turnId,
  seq: -1,
  at: 1,
});
const ended = (
  outcome: 'completed' | 'stopped' | 'failed' | 'interrupted',
  error?: { code: string; message: string },
  chatId = 'c1',
  turnId = 't1',
): WireEvent =>
  ({
    type: 'chat.turn_ended',
    chatId,
    turnId,
    seq: -1,
    at: 2,
    outcome,
    ...(error ? { error } : {}),
  }) as WireEvent;
const asked = (tool = 'AskUserQuestion', requestId = 'r1', chatId = 'c1'): WireEvent =>
  ({
    type: 'chat.permission_request',
    chatId,
    requestId,
    request: { tool, args: {} },
    seq: 3,
  }) as unknown as WireEvent;
const answered = (requestId = 'r1', chatId = 'c1'): WireEvent => ({
  type: 'chat.permission_response',
  chatId,
  requestId,
  approve: true,
});

const facts = (over: Partial<ChatStatusFacts> = {}): ChatStatusFacts => ({
  ...emptyFacts(),
  ...over,
});

describe('deriveStatus: every status from its facts', () => {
  test.each([
    ['nothing at all', facts(), 'idle'],
    ['a turn open', facts({ openTurns: ['t'] }), 'running'],
    [
      'an approval while its turn is open',
      facts({ openTurns: ['t'], openRequests: [{ id: 'r', question: false }] }),
      'waiting_for_user',
    ],
    [
      'a question after its turn ended',
      facts({ openRequests: [{ id: 'r', question: true }] }),
      'waiting_for_user',
    ],
    ['a declared question', facts({ declaredQuestion: true }), 'waiting_for_user'],
    ['a held message', facts({ held: true }), 'queued_offline'],
    [
      'a planned restart mid-turn',
      facts({ openTurns: ['t'], away: 'restarting' }),
      'host_restarting',
    ],
    ['a silent host mid-turn', facts({ openTurns: ['t'], away: 'offline' }), 'host_offline'],
    ['a cut-off turn', facts({ interrupted: true }), 'interrupted'],
    ['a turn ended interrupted', facts({ lastEnd: { outcome: 'interrupted' } }), 'interrupted'],
    ['a limit', facts({ limit: { reason: 'session', resetsAt: 5 } }), 'paused'],
    [
      'a signed-out account',
      facts({
        lastEnd: { outcome: 'failed', error: { code: 'claude_oauth_missing', message: 'm' } },
      }),
      'waiting_for_sign_in',
    ],
    [
      'a failed turn',
      facts({ lastEnd: { outcome: 'failed', error: { code: 'sdk_error', message: 'boom' } } }),
      'failed',
    ],
    ['a finished turn', facts({ lastEnd: { outcome: 'completed' } }), 'idle'],
    ['a stopped turn', facts({ lastEnd: { outcome: 'stopped' } }), 'idle'],
    ['a retry scheduled', facts({ retrying: true, lastEnd: { outcome: 'failed' } }), 'running'],
  ] as const)('%s → %s', (_name, f, expected) => {
    expect(deriveStatus(f).state).toBe(expected);
  });

  test('work the server owes keeps a chat running between turns', () => {
    expect(deriveStatus(facts({ lastEnd: { outcome: 'completed' } }), true).state).toBe('running');
  });

  test('a pause carries its reset time and account; a failure its reason and words', () => {
    expect(
      deriveStatus(facts({ limit: { reason: 'session', resetsAt: 5, accountId: 'a' } })),
    ).toEqual({ state: 'paused', reason: 'session', resetsAt: 5, accountId: 'a' });
    expect(
      deriveStatus(
        facts({
          lastEnd: {
            outcome: 'failed',
            error: { code: 'claude_session_missing', message: 'gone' },
          },
        }),
      ),
    ).toEqual({ state: 'failed', reason: 'session_gone', message: 'gone' });
    expect(deriveStatus(facts({ heldExpired: 'not delivered' }))).toEqual({
      state: 'failed',
      reason: 'held_message_expired',
      message: 'not delivered',
    });
  });

  test('a silent host outranks everything it was doing: never a stale running', () => {
    const f = facts({
      openTurns: ['t'],
      openRequests: [{ id: 'r', question: true }],
      away: 'offline',
    });
    expect(deriveStatus(f).state).toBe('host_offline');
  });
});

describe('facts', () => {
  test('a turn starting clears what the last one left behind', () => {
    const before = facts({
      lastEnd: { outcome: 'failed' },
      interrupted: true,
      limit: { reason: 'x' },
      retrying: true,
      held: true,
      heldExpired: 'x',
      away: 'offline',
    });
    expect(factsOnTurnStarted(before, 't')).toEqual(facts({ openTurns: ['t'] }));
  });

  test('a request stays open past its turn until the host resolves it', () => {
    let f = factsOnTurnStarted(emptyFacts(), 't');
    f = factsOnRequestRaised(f, 'a', 'Bash');
    f = factsOnRequestRaised(f, 'q', 'AskUserQuestion');
    f = factsOnTurnEnded(f, 't', 'completed', undefined);
    expect(deriveStatus(f).state).toBe('waiting_for_user');
    f = factsOnRequestResolved(f, 'a');
    f = factsOnRequestResolved(f, 'q');
    expect(f.openRequests).toEqual([]);
    expect(deriveStatus(f).state).toBe('idle');
  });

  test('a side branch is its own turn: the chat runs until both end', () => {
    let f = factsOnTurnStarted(emptyFacts(), 'main');
    f = factsOnTurnStarted(f, 'side');
    f = factsOnTurnEnded(f, 'main', 'completed', undefined);
    expect(deriveStatus(f).state).toBe('running');
    f = factsOnTurnEnded(f, 'side', 'completed', undefined);
    expect(deriveStatus(f).state).toBe('idle');
  });

  test("a host's chat.state states its facts whole, and says the host is back", () => {
    const f = factsFromHostState(
      facts({ interrupted: true, limit: { reason: 'x' }, away: 'offline' }),
      state({ statusKind: 'question', statusDeclared: true, turnRetrying: true }),
    );
    expect(f).toEqual(facts({ declaredQuestion: true, retrying: true }));
    expect(
      factsFromHostState(emptyFacts(), state({ rateLimitResumingAt: 9, resumeKind: 'overloaded' }))
        .limit,
    ).toEqual({ reason: 'overloaded', resetsAt: 9 });
  });

  test('a host activity on a chat.state is not a fact and changes nothing', () => {
    const f = factsFromHostState(emptyFacts(), state({ activity: 'running' }));
    expect(deriveStatus(f).state).toBe('idle');
  });
});

describe('transitions', () => {
  // spec/12 § Allowed transitions, row by row.
  test.each([
    ['idle', 'running'],
    ['interrupted', 'running'],
    ['paused', 'running'],
    ['waiting_for_sign_in', 'running'],
    ['failed', 'running'],
    ['running', 'waiting_for_user'],
    ['waiting_for_user', 'running'],
    ['running', 'idle'],
    ['waiting_for_user', 'idle'],
    ['running', 'paused'],
    ['running', 'waiting_for_sign_in'],
    ['running', 'failed'],
    ['running', 'host_restarting'],
    ['waiting_for_user', 'host_restarting'],
    ['running', 'host_offline'],
    ['waiting_for_user', 'host_offline'],
    ['host_restarting', 'host_offline'],
    ['host_restarting', 'running'],
    ['host_offline', 'running'],
    ['host_offline', 'waiting_for_user'],
    ['host_restarting', 'interrupted'],
    ['host_offline', 'interrupted'],
    ['host_offline', 'idle'],
    ['host_offline', 'failed'],
    ['host_offline', 'paused'],
    ['idle', 'queued_offline'],
    ['interrupted', 'queued_offline'],
    ['failed', 'queued_offline'],
    ['queued_offline', 'running'],
    ['paused', 'idle'],
    ['waiting_for_sign_in', 'idle'],
  ] as const)('%s → %s is allowed', (from, to) => {
    expect(isAllowedTransition(from, to)).toBe(true);
  });

  test.each([
    ['queued_offline', 'failed'],
    ['idle', 'host_offline'],
    ['idle', 'failed'],
    ['failed', 'idle'],
    ['host_offline', 'host_restarting'],
    ['paused', 'failed'],
  ] as const)('%s → %s is not', (from, to) => {
    expect(isAllowedTransition(from, to)).toBe(false);
  });

  test('a status may always stay put, and `since` moves only when the state changes', () => {
    expect(isAllowedTransition('failed', 'failed')).toBe(true);
    const a = nextStatus(null, { state: 'running' }, 10);
    const b = nextStatus(a, { state: 'running' }, 20);
    const c = nextStatus(b, { state: 'idle' }, 30);
    expect([a.since, b.since, c.since]).toEqual([10, 10, 30]);
  });
});

describe('legacyActivity', () => {
  test('keeps the old meaning for readers that predate chatStatus', () => {
    expect(legacyActivity(facts({ openTurns: ['t'] }))).toBe('running');
    expect(
      legacyActivity(facts({ openTurns: ['t'], openRequests: [{ id: 'r', question: false }] })),
    ).toBe('awaiting-permission');
    // A chat parked on the agent's own question takes a message as an idle one did.
    expect(legacyActivity(facts({ declaredQuestion: true }))).toBe('idle');
    expect(legacyActivity(facts({ lastEnd: { outcome: 'failed' } }))).toBe('errored');
    expect(legacyActivity(facts({ openTurns: ['t'], away: 'offline' }))).toBe('errored');
  });
});

describe('ChatRegistry status', () => {
  const spawned: WireEvent = { type: 'chat.spawned', chatId: 'c1', hostId: 'h1', folder: '/w' };
  const make = () => {
    let now = 100;
    const warnings: unknown[] = [];
    const logger = { warn: (o: unknown) => warnings.push(o) } as unknown as pino.Logger;
    const reg = new ChatRegistry({ now: () => now, logger });
    const told: ChatStateEvent[] = [];
    reg.onStatusChange((e) => told.push(e));
    return { reg, warnings, told, tick: (to: number) => (now = to) };
  };

  test('derives the status from turn facts and keeps it on the row', () => {
    const { reg, tick, told } = make();
    reg.observe(spawned);
    expect(reg.get('c1')?.chatStatus).toEqual({ state: 'idle', since: 100 });
    tick(200);
    reg.observe(started());
    expect(reg.get('c1')?.chatStatus).toEqual({ state: 'running', since: 200 });
    expect(reg.get('c1')?.activity).toBe('running');
    tick(300);
    reg.observe(ended('completed'));
    expect(reg.get('c1')?.chatStatus).toEqual({ state: 'idle', since: 300 });
    // Each change a fact made alone is told, for the server to send surfaces.
    expect(told.map((e) => e.chatStatus?.state)).toEqual(['running', 'idle']);
  });

  test("a host's chat.state saying running does not make a chat run", () => {
    const { reg } = make();
    reg.observe(spawned);
    reg.observe(state({ activity: 'running' }));
    expect(reg.get('c1')?.chatStatus?.state).toBe('idle');
  });

  test('the gate replaces what a host put in activity, lastError and chatStatus with the server word', () => {
    const { reg } = make();
    reg.observe(spawned);
    reg.observe(started());
    const out = reg.gate(
      state({
        activity: 'idle',
        lastError: { code: 'sdk_error', message: 'made up', at: 1 },
        chatStatus: { state: 'failed', since: 1 },
      }),
    ) as ChatStateEvent;
    expect(out.activity).toBe('running');
    expect(out.chatStatus?.state).toBe('running');
    expect(out.lastError).toBeUndefined();
  });

  test('a question raised and answered moves the chat to waiting and back', () => {
    const { reg } = make();
    reg.observe(spawned);
    reg.observe(started());
    reg.observe(asked('Bash'));
    expect(reg.get('c1')?.chatStatus?.state).toBe('waiting_for_user');
    reg.observe(answered());
    expect(reg.get('c1')?.chatStatus?.state).toBe('running');
  });

  test('a question replayed to one surface is history, not a new fact', () => {
    const { reg } = make();
    reg.observe(spawned);
    reg.observe({ ...(asked() as object), forSurfaceId: 's1' } as unknown as WireEvent);
    expect(reg.get('c1')?.chatStatus?.state).toBe('idle');
  });

  test('a browser hand-off that blocks the agent waits on the user; a shared view does not', () => {
    const { reg } = make();
    reg.observe(spawned);
    reg.observe(started());
    const handoff = (status: 'waiting' | 'ended', shared?: boolean): WireEvent =>
      ({
        type: 'patch.browser_handoff.state',
        chatId: 'c1',
        handoffId: 'h',
        tabId: 't',
        status,
        reason: 'log in',
        startedAt: 1,
        ...(shared ? { shared } : {}),
      }) as WireEvent;
    reg.observe(handoff('waiting', true));
    expect(reg.get('c1')?.chatStatus?.state).toBe('running');
    reg.observe(handoff('waiting'));
    expect(reg.get('c1')?.chatStatus?.state).toBe('waiting_for_user');
    reg.observe(handoff('ended'));
    expect(reg.get('c1')?.chatStatus?.state).toBe('running');
  });

  test('a failed turn reads failed with its reason, and says why to older readers', () => {
    const { reg } = make();
    reg.observe(spawned);
    reg.observe(started());
    reg.observe(ended('failed', { code: 'sdk_error', message: 'boom' }));
    expect(reg.get('c1')?.chatStatus).toMatchObject({
      state: 'failed',
      reason: 'sdk_error',
      message: 'boom',
    });
    expect(reg.get('c1')?.lastError).toMatchObject({ code: 'sdk_error', message: 'boom' });
    expect(reg.get('c1')?.activity).toBe('errored');
    reg.observe(started('c1', 't2'));
    expect(reg.get('c1')?.lastError).toBeNull();
  });

  test('a signed-out account waits for sign-in; a limit pauses with its reset', () => {
    const { reg } = make();
    reg.observe(spawned);
    reg.observe(started());
    reg.observe(ended('failed', { code: 'chatgpt_login_required', message: 'sign in' }));
    expect(reg.get('c1')?.chatStatus?.state).toBe('waiting_for_sign_in');
    reg.observe(started('c1', 't2'));
    reg.observe(ended('failed', { code: 'rate_limited', message: 'limit' }, 'c1', 't2'));
    reg.observe(
      state({
        limitBlock: { scope: 'session', resetsAt: 500 } as ChatStateEvent['limitBlock'],
      }),
    );
    expect(reg.get('c1')?.chatStatus).toMatchObject({ state: 'paused', resetsAt: 500 });
  });

  test('a host gone silent mid-turn makes the chat host offline, never failed or running', () => {
    const { reg } = make();
    reg.observe(spawned);
    reg.observe(started());
    const events = reg.markHostAway('h1', 'offline');
    expect(events.map((e) => e.chatStatus?.state)).toEqual(['host_offline']);
    expect(reg.get('c1')?.chatStatus?.state).toBe('host_offline');
    expect(reg.get('c1')?.lastError).toBeNull();
  });

  test('host offline then back with the turn still live reads running again', () => {
    const { reg, warnings } = make();
    reg.observe(spawned);
    reg.observe(started());
    reg.markHostAway('h1', 'offline');
    // The host speaks for the chat again; the turn it reattached to is still open.
    reg.observe(state());
    expect(reg.get('c1')?.chatStatus?.state).toBe('running');
    expect(warnings).toEqual([]);
  });

  test('host offline then back, its outbox says the turn ended while it was away', () => {
    const { reg, warnings } = make();
    reg.observe(spawned);
    reg.observe(started());
    reg.markHostAway('h1', 'offline');
    reg.observe(ended('completed'));
    expect(reg.get('c1')?.chatStatus?.state).toBe('idle');
    expect(warnings).toEqual([]);
  });

  test('host offline then back, and the turn died with its machine: interrupted', () => {
    const { reg, warnings } = make();
    reg.observe(spawned);
    reg.observe(started());
    reg.markHostAway('h1', 'offline');
    reg.observe(ended('interrupted'));
    reg.observe(state({ interrupted: true }));
    expect(reg.get('c1')?.chatStatus?.state).toBe('interrupted');
    expect(warnings).toEqual([]);
  });

  test('a chat with nothing running keeps its status when its host goes', () => {
    const { reg } = make();
    reg.observe(spawned);
    reg.observe(started());
    reg.observe(ended('failed', { code: 'sdk_error', message: 'x' }));
    expect(reg.markHostAway('h1', 'offline')).toEqual([]);
    expect(reg.get('c1')?.chatStatus?.state).toBe('failed');
  });

  test('a planned restart moves working chats on that host to host restarting, and no others', () => {
    const { reg } = make();
    for (const [chatId, hostId] of [
      ['run', 'h1'],
      ['wait', 'h1'],
      ['idle', 'h1'],
      ['other', 'h2'],
    ] as const) {
      reg.observe({ type: 'chat.spawned', chatId, hostId, folder: '/w' });
    }
    reg.observe(started('run', 'a'));
    reg.observe(asked('AskUserQuestion', 'q', 'wait'));
    reg.observe(started('other', 'b'));
    const events = reg.markHostAway('h1', 'restarting');
    expect(events.map((e) => [e.chatId, e.chatStatus?.state]).sort()).toEqual([
      ['run', 'host_restarting'],
      ['wait', 'host_restarting'],
    ]);
    expect(reg.get('idle')?.chatStatus?.state).toBe('idle');
    expect(reg.get('other')?.chatStatus?.state).toBe('running');
    // The window runs out: restarting becomes offline, never the reverse.
    expect(reg.markHostAway('h1', 'offline').map((e) => e.chatStatus?.state)).toEqual([
      'host_offline',
      'host_offline',
    ]);
    expect(reg.markHostAway('h1', 'restarting')).toEqual([]);
  });

  test('a held message queues an idle chat but not a running one, and a turn takes it', () => {
    const { reg } = make();
    reg.observe(spawned);
    expect(reg.markQueued('c1')?.chatStatus?.state).toBe('queued_offline');
    expect(reg.markQueued('c1')).toBeNull();
    reg.observe(started());
    expect(reg.get('c1')?.chatStatus?.state).toBe('running');
    expect(reg.markQueued('c1')).toBeNull();
  });

  test('a held message that expires fails the chat with why, as the server alone can', () => {
    const { reg, warnings } = make();
    reg.observe(spawned);
    reg.markQueued('c1');
    const ev = reg.markHeldExpired('c1', 'Not delivered');
    expect(ev?.chatStatus).toMatchObject({
      state: 'failed',
      reason: 'held_message_expired',
      message: 'Not delivered',
    });
    expect(warnings).toEqual([]);
  });

  test('a change no allowed transition covers is applied and logged as a fault', () => {
    const { reg, warnings } = make();
    reg.observe(spawned);
    reg.markQueued('c1');
    // Queued, then a cut-off turn reported with no turn ever started.
    reg.observe(state({ interrupted: true }));
    expect(reg.get('c1')?.chatStatus?.state).toBe('queued_offline');
    reg.observe(ended('failed', { code: 'sdk_error', message: 'x' }));
    // held outranks the failure until a turn takes the message: still queued
    expect(reg.get('c1')?.chatStatus?.state).toBe('queued_offline');
    expect(warnings).toEqual([]);
    const { reg: r2, warnings: w2 } = make();
    r2.observe(spawned);
    r2.observe(ended('failed', { code: 'sdk_error', message: 'x' }));
    // idle → failed without a turn running is outside the table: applied, logged.
    expect(r2.get('c1')?.chatStatus?.state).toBe('failed');
    expect(w2).toContainEqual(expect.objectContaining({ from: 'idle', to: 'failed' }));
  });

  test('work the server owes keeps the chat running and is worked out again when it goes', () => {
    const { reg, told } = make();
    let owed = true;
    reg.setOwedWork(() => owed);
    reg.observe(spawned);
    reg.observe(started());
    reg.observe(ended('completed'));
    expect(reg.get('c1')?.chatStatus?.state).toBe('running');
    owed = false;
    reg.recompute('c1');
    expect(reg.get('c1')?.chatStatus?.state).toBe('idle');
    expect(told.at(-1)?.chatStatus?.state).toBe('idle');
  });
});
