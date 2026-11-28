// Finished chats → the Manager (spec/06 § Finished chats), the server half:
// which chats count as finished and when a delivery is due. The turn itself
// is the home host's (`ChatRunner.deliverFinishedChats`, tested there).

import { describe, test, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { SPECIAL_THREAD_IDS, type WireEvent } from '@patch/wire';
import { ChatRegistry } from '../src/chat-registry.js';
import {
  ManagerFinishedCollector,
  IN_FLIGHT_STALE_MS,
  RETRY_AFTER_FAILURE_MS,
  type ManagerFinishedDeps,
} from '../src/manager-finished.js';
import { DEFAULT_SETTINGS, type AccountSettings } from '../src/settings.js';

const logger = pino({ level: 'silent' });

function spawned(chatId: string, hostId = 'd1'): WireEvent {
  return { type: 'chat.spawned', chatId, hostId, folder: `/work/${chatId}` } as WireEvent;
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
    ...over,
  } as WireEvent;
}

describe('ManagerFinishedCollector', () => {
  let chats: ChatRegistry;
  let settings: AccountSettings;
  let delivered: {
    runId: string;
    chats: { chatId: string; name: string; hostName?: string }[];
    windowMinutes?: number;
  }[];
  let collector: ManagerFinishedCollector;
  let nowMs: number;
  let hostOnline: boolean;
  let hostTakes: boolean | undefined;
  let reported: string[];

  function make(over: Partial<ManagerFinishedDeps> = {}): ManagerFinishedCollector {
    return new ManagerFinishedCollector({
      chats,
      settings: () => settings,
      managerHostId: () => (hostOnline ? 'd1' : undefined),
      hostTakesFinished: () => hostTakes,
      hostName: (id) => (id === 'd1' ? 'Studio Mac' : undefined),
      deliver: (req) => delivered.push(req),
      reportFailure: (m) => reported.push(m),
      logger,
      now: () => nowMs,
      idGenerator: () => `run-${delivered.length}`,
      ...over,
    });
  }

  // Production feeds the same event stream to the registry first, then here.
  function emit(event: WireEvent): void {
    chats.observe(event);
    collector.observe(event);
  }

  function finish(chatId: string, over: Partial<Record<string, unknown>> = {}): void {
    emit(spawned(chatId));
    emit(state(chatId, { activity: 'running' }));
    emit(state(chatId, { activity: 'idle', ...over }));
  }

  const ids = (i: number): string[] => delivered[i]!.chats.map((c) => c.chatId);

  beforeEach(() => {
    chats = new ChatRegistry({ logger });
    delivered = [];
    hostOnline = true;
    hostTakes = true;
    settings = { ...DEFAULT_SETTINGS, managerWake: 'batched', managerWakeIntervalMinutes: 30 };
    nowMs = 1_700_000_000_000;
    reported = [];
    collector = make();
  });

  test('off by default', () => {
    expect(DEFAULT_SETTINGS.managerWake).toBe('off');
  });

  test('off: nothing is collected, so turning it on later sends no backlog', () => {
    settings = { ...settings, managerWake: 'off' };
    finish('c1');
    expect(collector.pendingChats()).toEqual([]);
    settings = { ...settings, managerWake: 'batched' };
    nowMs += 31 * 60_000;
    expect(collector.tick()).toBe(false);
  });

  test('batched: one delivery per interval with every chat that finished, naming the interval', () => {
    finish('c1');
    finish('c2');
    expect(collector.tick()).toBe(false);
    nowMs += 30 * 60_000;
    expect(collector.tick()).toBe(true);
    expect(ids(0)).toEqual(['c1', 'c2']);
    expect(delivered[0]!.windowMinutes).toBe(30);
    expect(delivered[0]!.chats[0]).toMatchObject({ hostId: 'd1', folder: '/work/c1' });
  });

  test('batched: nothing finished is no delivery', () => {
    emit(spawned('c1'));
    emit(state('c1'));
    nowMs += 60 * 60_000;
    expect(collector.tick()).toBe(false);
    expect(delivered).toEqual([]);
  });

  test('each one: a delivery as the chat finishes, with no interval', () => {
    settings = { ...settings, managerWake: 'each' };
    finish('c1');
    expect(ids(0)).toEqual(['c1']);
    expect(delivered[0]!.windowMinutes).toBeUndefined();
  });

  test('deliveries never overlap: a chat finishing meanwhile goes in the next one', () => {
    settings = { ...settings, managerWake: 'each' };
    finish('c1');
    finish('c2');
    expect(delivered).toHaveLength(1);
    collector.onResult({ runId: 'run-0', delivered: 1 });
    expect(collector.tick()).toBe(true);
    expect(ids(1)).toEqual(['c2']);
  });

  test('a delivery that never reports back: its chats go again after a pause, and the user is told', () => {
    settings = { ...settings, managerWake: 'each' };
    finish('c1');
    finish('c2');
    expect(collector.tick()).toBe(false);
    nowMs += IN_FLIGHT_STALE_MS + 1;
    expect(collector.tick()).toBe(false);
    expect(collector.pendingChats()).toEqual(['c1', 'c2']);
    expect(reported).toEqual([
      'Finished chats were not delivered to the Manager: the Manager’s home host did not answer. Patch will try again.',
    ]);
    nowMs += RETRY_AFTER_FAILURE_MS;
    expect(collector.tick()).toBe(true);
    expect(ids(1)).toEqual(['c1', 'c2']);
  });

  test('a chat running again when a failed delivery is retried is left out of the retry', () => {
    settings = { ...settings, managerWake: 'each' };
    finish('c1');
    emit(state('c1', { activity: 'running' }));
    collector.onResult({ runId: 'run-0', delivered: 0, error: 'boom', recorded: true });
    expect(collector.pendingChats()).toEqual(['c1']);
    nowMs += RETRY_AFTER_FAILURE_MS;
    expect(collector.tick()).toBe(false);
    expect(delivered).toHaveLength(1);
  });

  test('a refused delivery keeps its chats; the thread already says so, so no notification', () => {
    finish('c1');
    nowMs += 30 * 60_000;
    collector.tick();
    finish('c2');
    collector.onResult({ runId: 'run-0', delivered: 0, error: 'boom', recorded: true });
    expect(collector.pendingChats()).toEqual(['c1', 'c2']);
    expect(reported).toEqual([]);
    // Batched: the retry does not wait for the next interval, only the pause.
    expect(collector.tick()).toBe(false);
    nowMs += RETRY_AFTER_FAILURE_MS;
    expect(collector.tick()).toBe(true);
    expect(ids(1)).toEqual(['c1', 'c2']);
    collector.onResult({ runId: 'run-1', delivered: 2 });
    expect(collector.pendingChats()).toEqual([]);
  });

  test('a failure the thread could not record is notified, once per run of failures', () => {
    settings = { ...settings, managerWake: 'each' };
    finish('c1');
    collector.onResult({
      runId: 'run-0',
      delivered: 0,
      error: 'this host does not run the Manager',
    });
    nowMs += RETRY_AFTER_FAILURE_MS;
    collector.tick();
    collector.onResult({
      runId: 'run-1',
      delivered: 0,
      error: 'this host does not run the Manager',
    });
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('this host does not run the Manager');
    expect(collector.pendingChats()).toEqual(['c1']);
  });

  test('a delivery that cannot be sent at all keeps its chats', () => {
    settings = { ...settings, managerWake: 'each' };
    collector = make({
      deliver: () => {
        throw new Error('the Manager has no home host');
      },
    });
    finish('c1');
    expect(collector.pendingChats()).toEqual(['c1']);
    expect(reported[0]).toContain('the Manager has no home host');
  });

  test('a failed delivery to a Manager disabled meanwhile is not kept', () => {
    settings = { ...settings, managerWake: 'each' };
    finish('c1');
    emit(spawned(SPECIAL_THREAD_IDS.manager));
    emit(state(SPECIAL_THREAD_IDS.manager, { disabled: true }));
    collector.onResult({ runId: 'run-0', delivered: 0, error: 'the Manager is disabled' });
    expect(collector.pendingChats()).toEqual([]);
    expect(reported).toEqual([]);
  });

  test('an offline home host keeps the chats for when it is back', () => {
    settings = { ...settings, managerWake: 'each' };
    hostOnline = false;
    finish('c1');
    expect(delivered).toEqual([]);
    hostOnline = true;
    expect(collector.tick()).toBe(true);
    expect(ids(0)).toEqual(['c1']);
  });

  test('left out: stopped, goal running, snoozed, hidden, archived, special threads', () => {
    finish('stopped', { turnStopped: true });
    finish('goal', { goal: 'Ship it' });
    finish('snoozed', { snoozedUntil: nowMs + 60_000 });
    finish('hidden', { hidden: true });
    finish('archived', { status: 'archived' });
    finish(SPECIAL_THREAD_IDS.manager);
    finish(SPECIAL_THREAD_IDS.speakers);
    expect(collector.pendingChats()).toEqual([]);
  });

  test('a chat that starts running again before the delivery is dropped', () => {
    finish('c1');
    emit(state('c1', { activity: 'running' }));
    nowMs += 31 * 60_000;
    expect(collector.tick()).toBe(false);
  });

  test('an idle chat whose goal is met or given up counts as finished', () => {
    emit(spawned('g1'));
    emit(state('g1', { activity: 'running', goal: 'Ship it' }));
    emit(state('g1', { activity: 'idle', goal: 'Ship it' }));
    expect(collector.pendingChats()).toEqual([]);
    // The host clears the goal in a later frame, the chat already idle.
    emit(state('g1', { activity: 'idle', goal: null }));
    expect(collector.pendingChats()).toEqual(['g1']);
    // A goal cleared while it is still running is not finished.
    emit(spawned('g2'));
    emit(state('g2', { activity: 'running', goal: 'More' }));
    emit(state('g2', { activity: 'running', goal: null }));
    expect(collector.pendingChats()).toEqual(['g1']);
  });

  test('at delivery every check is run again: snoozed, hidden, archived, deleted, running, goal', () => {
    for (const id of ['ok', 'snoozed', 'hidden', 'archived', 'deleted', 'running', 'goal']) {
      finish(id);
    }
    emit(state('snoozed', { snoozedUntil: nowMs + 60 * 60_000 }));
    emit(state('hidden', { hidden: true }));
    emit(state('archived', { status: 'archived' }));
    emit(state('deleted', { status: 'deleted' }));
    emit(state('running', { activity: 'running' }));
    emit(state('goal', { goal: 'Keep going' }));
    nowMs += 31 * 60_000;
    collector.tick();
    expect(ids(0)).toEqual(['ok']);
  });

  test('names the host, and an unnamed chat by its folder’s last part', () => {
    finish('c1');
    collector.sendNow();
    expect(delivered[0]!.chats[0]).toMatchObject({ name: 'c1', hostName: 'Studio Mac' });
  });

  test('pending chats and the batch clock survive a restart', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mf-')), 'manager-finished.json');
    collector = make({ path });
    finish('c1');
    finish('c2');
    nowMs += 10 * 60_000;
    collector = make({ path });
    expect(collector.pendingChats()).toEqual(['c1', 'c2']);
    // The clock kept running: 20 more minutes is the interval, not 30.
    nowMs += 20 * 60_000;
    expect(collector.tick()).toBe(true);
    expect(ids(0)).toEqual(['c1', 'c2']);
    // Unconfirmed when the server stops: still there after it starts.
    collector = make({ path });
    expect(collector.pendingChats()).toEqual(['c1', 'c2']);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 2 });
  });

  test('an unreadable file is logged and the collector starts empty', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mf-')), 'manager-finished.json');
    writeFileSync(path, '{not json');
    const errors: string[] = [];
    collector = make({
      path,
      logger: { info: () => {}, warn: () => {}, error: (_o: unknown, m: string) => errors.push(m) },
    } as Partial<ManagerFinishedDeps>);
    expect(collector.pendingChats()).toEqual([]);
    expect(errors).toEqual(['manager-finished: pending chats file is unreadable, starting empty']);
    finish('c1');
    expect(JSON.parse(readFileSync(path, 'utf8')).pending).toEqual(['c1']);
  });

  test('a chat given a goal after it finished is dropped at delivery', () => {
    finish('c1');
    finish('c2');
    emit(state('c1', { activity: 'idle', goal: 'Keep going' }));
    nowMs += 31 * 60_000;
    collector.tick();
    expect(ids(0)).toEqual(['c2']);
  });

  test('a disabled Manager is sent nothing and nothing is kept', () => {
    emit(spawned(SPECIAL_THREAD_IDS.manager));
    emit(state(SPECIAL_THREAD_IDS.manager, { disabled: true }));
    finish('c1');
    nowMs += 31 * 60_000;
    expect(collector.tick()).toBe(false);
    expect(collector.pendingChats()).toEqual([]);
  });

  test('send now: delivers before the interval, without naming one', () => {
    finish('c1');
    expect(collector.sendNow()).toEqual({ outcome: 'sent', chats: 1 });
    expect(delivered[0]!.windowMinutes).toBeUndefined();
  });

  test('send now names what happened: nothing waiting, in flight, sent, refused', () => {
    expect(collector.sendNow()).toEqual({ outcome: 'nothing-waiting' });
    finish('c1');
    finish('c2');
    expect(collector.sendNow()).toEqual({ outcome: 'sent', chats: 2 });
    expect(collector.sendNow()).toEqual({ outcome: 'in-flight', chats: 2 });
    collector.onResult({ runId: 'run-0', delivered: 2 });
    finish('c3');
    hostOnline = false;
    expect(collector.sendNow()).toEqual({
      outcome: 'refused',
      reason: 'the Manager’s home host is offline',
    });
    settings = { ...settings, managerWake: 'off' };
    expect(collector.sendNow()).toEqual({ outcome: 'refused', reason: 'finished chats are off' });
  });

  test('batched after a quiet spell: the window starts when the first chat joins, not at the last delivery', () => {
    finish('c1');
    nowMs += 30 * 60_000;
    expect(collector.tick()).toBe(true);
    collector.onResult({ runId: 'run-0', delivered: 1 });
    // Hours pass with nothing finishing.
    nowMs += 5 * 60 * 60_000;
    expect(collector.tick()).toBe(false);
    finish('c2');
    // The first finish after the quiet waits the full interval.
    expect(collector.tick()).toBe(false);
    nowMs += 29 * 60_000;
    finish('c3');
    expect(collector.tick()).toBe(false);
    nowMs += 60_000;
    expect(collector.tick()).toBe(true);
    expect(ids(1)).toEqual(['c2', 'c3']);
  });

  test('the window closes when the batch empties: a chat that ran again does not keep it open', () => {
    finish('c1');
    emit(state('c1', { activity: 'running' }));
    nowMs += 40 * 60_000;
    emit(state('c1', { activity: 'idle' }));
    expect(collector.tick()).toBe(false);
    nowMs += 30 * 60_000;
    expect(collector.tick()).toBe(true);
  });

  test('the window start survives a restart', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mf-')), 'manager-finished.json');
    collector = make({ path });
    nowMs += 3 * 60 * 60_000;
    finish('c1');
    nowMs += 20 * 60_000;
    collector = make({ path });
    expect(collector.tick()).toBe(false);
    nowMs += 10 * 60_000;
    expect(collector.tick()).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      version: 2,
      windowStartedAt: null,
    });
  });

  test('a file from the first release loads: its chats and their clock are kept', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mf-')), 'manager-finished.json');
    emit(spawned('c1'));
    writeFileSync(
      path,
      JSON.stringify({ version: 1, pending: ['c1'], lastDeliveryAt: nowMs - 25 * 60_000 }),
    );
    collector = make({ path });
    expect(collector.pendingChats()).toEqual(['c1']);
    expect(collector.tick()).toBe(false);
    nowMs += 5 * 60_000;
    expect(collector.tick()).toBe(true);
  });

  test('a home host too old for finished chats keeps them and says so once', () => {
    settings = { ...settings, managerWake: 'each' };
    hostTakes = false;
    finish('c1');
    finish('c2');
    collector.tick();
    expect(delivered).toEqual([]);
    expect(collector.pendingChats()).toEqual(['c1', 'c2']);
    expect(reported).toEqual(['Manager host Studio Mac needs updating for finished chats']);
    expect(collector.sendNow()).toEqual({
      outcome: 'refused',
      reason: 'Manager host Studio Mac needs updating for finished chats',
    });
    expect(collector.status()).toMatchObject({
      waiting: 2,
      held: 'Manager host Studio Mac needs updating for finished chats',
    });
    expect(reported).toHaveLength(1);
    // Updated: the kept chats go.
    hostTakes = true;
    expect(collector.tick()).toBe(true);
    expect(ids(0)).toEqual(['c1', 'c2']);
    // Too old again later (a downgrade) is a new condition, said again.
    collector.onResult({ runId: 'run-0', delivered: 2 });
    hostTakes = false;
    finish('c3');
    expect(reported).toHaveLength(2);
  });

  test('a home host that has not described itself yet is waited for, silently', () => {
    settings = { ...settings, managerWake: 'each' };
    hostTakes = undefined;
    finish('c1');
    expect(delivered).toEqual([]);
    expect(reported).toEqual([]);
    hostTakes = true;
    expect(collector.tick()).toBe(true);
  });

  test('status: what is waiting, what is being sent, and the last delivery', () => {
    expect(collector.status()).toEqual({ waiting: 0, sending: 0, lastSent: null });
    finish('c1');
    finish('c2');
    expect(collector.status()).toEqual({ waiting: 2, sending: 0, lastSent: null });
    collector.sendNow();
    finish('c3');
    expect(collector.status()).toEqual({ waiting: 1, sending: 2, lastSent: null });
    nowMs += 1000;
    collector.onResult({ runId: 'run-0', delivered: 2 });
    expect(collector.status()).toEqual({
      waiting: 1,
      sending: 0,
      lastSent: { at: nowMs, chats: 2 },
    });
  });
});
