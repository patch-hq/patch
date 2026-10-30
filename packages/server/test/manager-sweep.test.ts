// The Manager sweep (spec/06 § The sweep) — the server-side facts: which chats
// went idle since the last check, and when a run is due (the interval, or
// "Check now"). The decision/execution half lives on the Manager host
// (`managerSweepGen.ts`, `ChatRunner.runManagerSweep`, tested there). There is
// deliberately nothing here about stalls, wakes or ranking reasons.

import { describe, test, expect, beforeEach } from 'vitest';
import pino from 'pino';
import { SPECIAL_THREAD_IDS, type WireEvent } from '@patch/wire';
import { ChatRegistry } from '../src/chat-registry.js';
import { ManagerSweeper, IN_FLIGHT_STALE_MS, type SweepRunStore } from '../src/manager-sweep.js';
import { DEFAULT_SETTINGS, type AccountSettings } from '../src/settings.js';

const logger = pino({ level: 'silent' });

function spawned(chatId: string, hostId = 'd1'): WireEvent {
  return {
    type: 'chat.spawned',
    chatId,
    hostId,
    folder: `/work/${chatId}`,
    seq: 1,
    ts: 0,
  } as WireEvent;
}

function state(chatId: string, over: Partial<Record<string, unknown>> = {}): WireEvent {
  return {
    type: 'chat.state',
    chatId,
    hostId: 'd1',
    activity: 'idle',
    permissionMode: 'auto',
    folder: `/work/${chatId}`,
    lastUpdated: 0,
    seq: 2,
    ts: 0,
    ...over,
  } as WireEvent;
}

function memoryRunStore(): SweepRunStore & { records: unknown[] } {
  const records: unknown[] = [];
  return {
    records,
    append: (r) => records.push(r),
    recent: (limit = 50) => records.slice(-limit).reverse() as never,
  };
}

describe('ManagerSweeper', () => {
  let chats: ChatRegistry;
  let settings: AccountSettings;
  let requested: { runId: string; candidates: { chatId: string; edge: string }[] }[];
  let sweeper: ManagerSweeper;
  let nowMs: number;
  let cancels: number;
  let runs: ReturnType<typeof memoryRunStore>;

  // Production feeds the SAME wire-event stream into both observers
  // (`app.ts`'s `hostLink.onEvent`) — the registry for state, the sweeper
  // for the idle facts.
  function emit(event: WireEvent): void {
    chats.observe(event);
    sweeper.observe(event);
  }

  function goIdle(chatId: string, over: Partial<Record<string, unknown>> = {}): void {
    emit(spawned(chatId));
    emit(state(chatId, { activity: 'running' }));
    emit(state(chatId, { activity: 'idle', ...over }));
  }

  beforeEach(() => {
    chats = new ChatRegistry({ logger });
    requested = [];
    cancels = 0;
    runs = memoryRunStore();
    settings = { ...DEFAULT_SETTINGS, sweepEnabled: true, sweepIntervalMinutes: 30 };
    nowMs = 1_700_000_000_000;
    sweeper = new ManagerSweeper({
      chats,
      settings: () => settings,
      managerHostId: () => 'd1',
      runSweep: (req) => requested.push({ runId: req.runId, candidates: req.candidates }),
      cancelSweep: () => {
        cancels++;
        return true;
      },
      runs,
      logger,
      now: () => nowMs,
      idGenerator: () => `run-${requested.length}`,
    });
  });

  test('the sweep is off by default', () => {
    expect(DEFAULT_SETTINGS.sweepEnabled).toBe(false);
  });

  test('nothing went idle means tick() makes no request at all', () => {
    emit(spawned('c1'));
    emit(state('c1'));
    nowMs += 60 * 60_000;
    expect(sweeper.tick()).toBe(false);
    expect(requested).toEqual([]);
  });

  test('an idle chat is pending, but the interval has not elapsed yet', () => {
    goIdle('c1');
    expect(sweeper.pendingChats()).toEqual(['c1']);
    expect(sweeper.tick()).toBe(false);
    expect(requested).toEqual([]);
  });

  test('fires once the interval elapses, with the idle chat as the only fact', () => {
    goIdle('c1');
    nowMs += 30 * 60_000;
    expect(sweeper.tick()).toBe(true);
    expect(requested).toHaveLength(1);
    expect(requested[0]!.candidates).toEqual([
      {
        chatId: 'c1',
        hostId: 'd1',
        folder: '/work/c1',
        edge: 'settled',
        idleMinutes: expect.any(Number),
      },
    ]);
    expect(sweeper.pendingChats()).toEqual([]);
  });

  test('instant (interval 0): a run starts as the chat goes idle, no waiting for a tick', () => {
    settings = { ...settings, sweepIntervalMinutes: 0 };
    goIdle('c1');
    expect(requested).toHaveLength(1);
    expect(requested[0]!.candidates.map((c) => c.chatId)).toEqual(['c1']);
  });

  test('instant: a chat going idle while a run is in flight is picked up once it reports back', () => {
    settings = { ...settings, sweepIntervalMinutes: 0 };
    goIdle('c1');
    goIdle('c2');
    expect(requested).toHaveLength(1);
    sweeper.onResult({ runId: 'run-0', actions: [], tokensUsed: 0 });
    expect(sweeper.tick()).toBe(true);
    expect(requested[1]!.candidates.map((c) => c.chatId)).toEqual(['c2']);
  });

  test('instant: nothing is sent while the sweep is off', () => {
    settings = { ...settings, sweepIntervalMinutes: 0, sweepEnabled: false };
    goIdle('c1');
    expect(requested).toEqual([]);
  });

  test('batched: a chat going idle waits for the interval', () => {
    goIdle('c1');
    expect(requested).toEqual([]);
  });

  test('a chat is reported once: nothing new going idle means no second run', () => {
    goIdle('c1');
    nowMs += 30 * 60_000;
    expect(sweeper.tick()).toBe(true);
    sweeper.onResult({ runId: 'run-0', actions: [], tokensUsed: 0 });
    nowMs += 30 * 60_000;
    expect(sweeper.tick()).toBe(false);
    expect(requested).toHaveLength(1);
  });

  test('a turn the user stopped did not end in a question — not collected', () => {
    goIdle('c1', { turnStopped: true });
    expect(sweeper.pendingChats()).toEqual([]);
  });

  test('a chat that starts working again before the check is no longer pending', () => {
    goIdle('c1');
    emit(state('c1', { activity: 'running' }));
    expect(sweeper.pendingChats()).toEqual([]);
  });

  test('there is no stall detection: a chat running for hours raises nothing', () => {
    emit(spawned('c1'));
    emit(state('c1', { activity: 'running' }));
    nowMs += 6 * 60 * 60_000;
    expect(sweeper.tick()).toBe(false);
    expect(sweeper.pendingChats()).toEqual([]);
    expect(requested).toEqual([]);
  });

  test('only going idle counts: a background task ending, an awaiting-permission chat or a declared question raise nothing', () => {
    emit(spawned('c1'));
    emit(state('c1', { activity: 'running', backgroundTasks: 2 }));
    emit(state('c1', { activity: 'running', backgroundTasks: 0 }));
    emit(state('c1', { activity: 'awaiting-permission' }));
    emit(state('c1', { statusKind: 'question', statusDeclared: true }));
    expect(sweeper.pendingChats()).toEqual([]);
  });

  test('a chat settling after the sweep answered it is collected again, so a chain of rote questions can continue', () => {
    goIdle('c1');
    nowMs += 30 * 60_000;
    sweeper.tick();
    sweeper.onResult({
      runId: 'run-0',
      actions: [{ chatId: 'c1', action: 'answer', detail: 'Yes, carry on.' }],
      tokensUsed: 10,
    });
    emit(state('c1', { activity: 'running', turnOrigin: 'machine' }));
    emit(state('c1', { activity: 'idle', turnOrigin: 'machine' }));
    expect(sweeper.pendingChats()).toEqual(['c1']);
  });

  test('archived, hidden and snoozed chats are not collected', () => {
    goIdle('a', { status: 'archived' });
    goIdle('h', { hidden: true });
    goIdle('s', { snoozedUntil: nowMs + 3_600_000 });
    expect(sweeper.pendingChats()).toEqual([]);
  });

  test('the Manager thread is never a candidate on itself', () => {
    goIdle(SPECIAL_THREAD_IDS.manager);
    expect(sweeper.pendingChats()).toEqual([]);
  });

  test('sweep setting off: pending is dropped, host told once, nothing fires on re-enable', () => {
    goIdle('c1');
    settings = { ...settings, sweepEnabled: false };
    nowMs += 30 * 60_000;
    expect(sweeper.tick()).toBe(false);
    expect(sweeper.tick()).toBe(false);
    expect(cancels).toBe(1);
    expect(sweeper.pendingChats()).toEqual([]);
    settings = { ...settings, sweepEnabled: true };
    nowMs += 30 * 60_000;
    expect(sweeper.tick()).toBe(false);
    expect(requested).toEqual([]);
  });

  test('chats that go idle while the sweep is off are not collected', () => {
    settings = { ...settings, sweepEnabled: false };
    goIdle('c1');
    expect(sweeper.pendingChats()).toEqual([]);
  });

  test('turning the sweep off while a run is in flight cancels it on the host', () => {
    goIdle('c1');
    nowMs += 30 * 60_000;
    expect(sweeper.tick()).toBe(true);
    settings = { ...settings, sweepEnabled: false };
    expect(sweeper.tick()).toBe(false);
    expect(cancels).toBe(1);
    // the run it abandoned no longer blocks a later one
    settings = { ...settings, sweepEnabled: true };
    goIdle('c2');
    nowMs += 30 * 60_000;
    expect(sweeper.tick()).toBe(true);
  });

  test('Manager disabled counts as off too', () => {
    emit(spawned(SPECIAL_THREAD_IDS.manager));
    emit(state(SPECIAL_THREAD_IDS.manager, { disabled: true }));
    goIdle('c1');
    nowMs += 30 * 60_000;
    expect(sweeper.pendingChats()).toEqual([]);
    expect(sweeper.tick()).toBe(false);
    expect(requested).toEqual([]);
  });

  test('"Check now" fires immediately, bypassing the interval — but still requires a chat gone idle', () => {
    expect(sweeper.checkNow()).toBe(false);
    goIdle('c1');
    expect(sweeper.checkNow()).toBe(true);
    expect(requested).toHaveLength(1);
  });

  test('sweepEnabled: false refuses even "Check now"', () => {
    goIdle('c1');
    settings = { ...settings, sweepEnabled: false };
    expect(sweeper.checkNow()).toBe(false);
    expect(requested).toEqual([]);
  });

  test('only one sweep runs at a time — a second fire is refused until the result comes back', () => {
    goIdle('c1');
    expect(sweeper.checkNow()).toBe(true);
    goIdle('c2');
    expect(sweeper.checkNow()).toBe(false);
    sweeper.onResult({ runId: 'run-0', actions: [], tokensUsed: 0 });
    goIdle('c3');
    expect(sweeper.checkNow()).toBe(true);
  });

  test('a run whose result never comes back stops blocking the sweep once it is stale', () => {
    goIdle('c1');
    expect(sweeper.checkNow()).toBe(true);
    goIdle('c2');
    nowMs += IN_FLIGHT_STALE_MS + 1;
    expect(sweeper.checkNow()).toBe(true);
  });

  test('without a Manager host registered, a sweep never fires', () => {
    const noHost = new ManagerSweeper({
      chats,
      settings: () => settings,
      managerHostId: () => undefined,
      runSweep: () => requested.push({ runId: 'x', candidates: [] }),
      cancelSweep: () => false,
      runs,
      logger,
      now: () => nowMs,
    });
    chats.observe(spawned('c1'));
    for (const activity of ['running', 'idle']) noHost.observe(state('c1', { activity }));
    expect(noHost.checkNow()).toBe(false);
    expect(requested).toEqual([]);
  });

  test('a vanished candidate is dropped, not sent', () => {
    emit(state('ghost', { activity: 'running' }));
    sweeper.observe(state('ghost', { activity: 'idle' }));
    expect(sweeper.pendingChats()).toEqual(['ghost']);
    expect(sweeper.checkNow()).toBe(false);
    expect(requested).toEqual([]);
  });

  test('onResult records the run even when it carries an error', () => {
    sweeper.onResult({ runId: 'r', actions: [], tokensUsed: 0, error: 'boom' });
    expect(runs.records).toHaveLength(1);
    expect(runs.records[0]).toMatchObject({ runId: 'r', error: 'boom' });
  });
});
