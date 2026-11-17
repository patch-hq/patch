// A chat's status, decided by the server alone (spec/12 § Chat status).

import { describe, test, expect } from 'vitest';
import pino from 'pino';
import type { ChatStateEvent, WireEvent } from '@patch/wire';
import { isAllowedTransition, nextStatus, statusFromHostState } from '../src/chat-status.js';
import { ChatRegistry } from '../src/chat-registry.js';

const state = (over: Partial<ChatStateEvent> = {}): ChatStateEvent =>
  ({
    type: 'chat.state',
    chatId: 'c1',
    hostId: 'h1',
    activity: 'idle',
    permissionMode: 'auto',
    lastUpdated: 1,
    ...over,
  }) as ChatStateEvent;

describe('statusFromHostState', () => {
  test.each([
    [{ activity: 'running' }, 'running'],
    [{ activity: 'awaiting-permission' }, 'waiting_for_user'],
    [{ activity: 'idle' }, 'idle'],
    [{ activity: 'idle', statusKind: 'question', statusDeclared: true }, 'waiting_for_user'],
    [{ activity: 'idle', statusKind: 'question', statusDeclared: false }, 'idle'],
    [{ activity: 'idle', rateLimitResumingAt: 99 }, 'paused'],
    [
      { activity: 'errored', lastError: { code: 'chatgpt_login_required', message: 'm', at: 1 } },
      'waiting_for_sign_in',
    ],
    [
      { activity: 'errored', lastError: { code: 'daemon_unavailable', message: 'm', at: 1 } },
      'host_offline',
    ],
    [{ activity: 'errored', lastError: { code: 'sdk_error', message: 'boom', at: 1 } }, 'failed'],
    [{ activity: 'errored', lastError: null }, 'failed'],
  ] as const)('%j → %s', (over, expected) => {
    expect(statusFromHostState(state(over as Partial<ChatStateEvent>)).state).toBe(expected);
  });

  test('a limit block pauses with its reset time and account, whatever the activity', () => {
    const s = statusFromHostState(
      state({
        activity: 'errored',
        limitBlock: {
          scope: 'session',
          resetsAt: 500,
          accountId: 'acc',
        } as ChatStateEvent['limitBlock'],
      }),
    );
    expect(s).toEqual({ state: 'paused', reason: 'session', resetsAt: 500, accountId: 'acc' });
  });

  test('a gone provider session is a failure that says so', () => {
    const s = statusFromHostState(
      state({
        activity: 'errored',
        lastError: { code: 'claude_session_missing', message: 'gone', at: 1 },
      }),
    );
    expect(s).toMatchObject({ state: 'failed', reason: 'session_gone' });
  });
});

describe('transitions', () => {
  test('nothing goes straight from offline-queued to failed, and a status may always stay put', () => {
    expect(isAllowedTransition('queued_offline', 'failed')).toBe(false);
    expect(isAllowedTransition('failed', 'failed')).toBe(true);
    expect(isAllowedTransition('running', 'host_offline')).toBe(true);
    expect(isAllowedTransition('host_offline', 'running')).toBe(true);
  });

  test('`since` moves only when the state changes', () => {
    const a = nextStatus(null, { state: 'running' }, 10);
    const b = nextStatus(a, { state: 'running' }, 20);
    const c = nextStatus(b, { state: 'idle' }, 30);
    expect([a.since, b.since, c.since]).toEqual([10, 10, 30]);
  });
});

describe('ChatRegistry status', () => {
  const spawned: WireEvent = { type: 'chat.spawned', chatId: 'c1', hostId: 'h1', folder: '/w' };
  const make = () => {
    let now = 100;
    const warnings: unknown[] = [];
    const logger = { warn: (o: unknown) => warnings.push(o) } as unknown as pino.Logger;
    const reg = new ChatRegistry({ now: () => now, logger });
    return { reg, warnings, tick: (to: number) => (now = to) };
  };

  test('derives the status from each host report and keeps it on the row', () => {
    const { reg, tick } = make();
    reg.observe(spawned);
    expect(reg.get('c1')?.chatStatus).toEqual({ state: 'idle', since: 100 });
    tick(200);
    reg.observe(state({ activity: 'running' }));
    expect(reg.get('c1')?.chatStatus).toEqual({ state: 'running', since: 200 });
  });

  test('a host gone mid-turn makes the chat host offline, never failed', () => {
    const { reg } = make();
    reg.observe(spawned);
    reg.observe(state({ activity: 'running' }));
    const ev = reg.markErrored('c1', { code: 'daemon_unavailable', message: 'host gone' }, 5);
    expect(ev?.chatStatus?.state).toBe('host_offline');
    expect(reg.get('c1')?.chatStatus?.state).toBe('host_offline');
  });

  test('a message held for an offline host queues an idle chat but not a running one', () => {
    const { reg } = make();
    reg.observe(spawned);
    expect(reg.markQueued('c1')?.chatStatus?.state).toBe('queued_offline');
    expect(reg.markQueued('c1')).toBeNull(); // already queued: nothing to broadcast
    reg.observe(state({ activity: 'running' }));
    expect(reg.markQueued('c1')).toBeNull();
  });

  test('a host report outside the allowed changes still wins, and is logged as a fault', () => {
    const { reg, warnings } = make();
    reg.observe(spawned);
    reg.markQueued('c1');
    reg.observe(
      state({ activity: 'errored', lastError: { code: 'sdk_error', message: 'x', at: 1 } }),
    );
    expect(reg.get('c1')?.chatStatus?.state).toBe('failed');
    expect(warnings).toContainEqual(
      expect.objectContaining({ from: 'queued_offline', to: 'failed' }),
    );
  });
});
