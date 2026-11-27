// Finished chats → the Manager (spec/06 § Finished chats), the server half:
// which chats count as finished and when a delivery is due. The turn itself
// is the home host's (`ChatRunner.deliverFinishedChats`, tested there).

import { describe, test, expect, beforeEach } from 'vitest';
import pino from 'pino';
import { SPECIAL_THREAD_IDS, type WireEvent } from '@patch/wire';
import { ChatRegistry } from '../src/chat-registry.js';
import { ManagerFinishedCollector, IN_FLIGHT_STALE_MS } from '../src/manager-finished.js';
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
  let delivered: { runId: string; chats: { chatId: string }[]; windowMinutes?: number }[];
  let collector: ManagerFinishedCollector;
  let nowMs: number;
  let hostOnline: boolean;

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
    settings = { ...DEFAULT_SETTINGS, managerWake: 'batched', managerWakeIntervalMinutes: 30 };
    nowMs = 1_700_000_000_000;
    collector = new ManagerFinishedCollector({
      chats,
      settings: () => settings,
      managerHostId: () => (hostOnline ? 'd1' : undefined),
      deliver: (req) => delivered.push(req),
      logger,
      now: () => nowMs,
      idGenerator: () => `run-${delivered.length}`,
    });
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

  test('a delivery that never reports back stops blocking after a while', () => {
    settings = { ...settings, managerWake: 'each' };
    finish('c1');
    finish('c2');
    expect(collector.tick()).toBe(false);
    nowMs += IN_FLIGHT_STALE_MS + 1;
    expect(collector.tick()).toBe(true);
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
    expect(collector.sendNow()).toBe(true);
    expect(delivered[0]!.windowMinutes).toBeUndefined();
    expect(collector.sendNow()).toBe(false);
  });
});
