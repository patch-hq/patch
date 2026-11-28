// Handover push (spec/05 § Handover — Server): a move wakes the phones once it
// has held, one push for a burst of moves, never the phone that moved, nothing
// when the setting is off.

import { describe, it, expect, vi } from 'vitest';
import { ViewPositionStore } from '../src/view-position.js';
import { startHandoverPush, handoverPushData } from '../src/view-position-push.js';

function rig(opts: { enabled?: boolean } = {}) {
  vi.useFakeTimers();
  let now = 1000;
  const store = new ViewPositionStore({ nowMs: () => now });
  const sent: { tokens: string[]; data: Record<string, string> }[] = [];
  const logs: string[] = [];
  const stop = startHandoverPush({
    viewPosition: store,
    enabled: () => opts.enabled ?? true,
    phones: () => [
      { surfaceId: 'phone', token: 'tok-phone' },
      { surfaceId: 'phone-repaired', token: 'tok-phone' },
      { surfaceId: 'tablet', token: 'tok-tablet' },
    ],
    sendData: async (tokens, data) => {
      sent.push({ tokens, data });
      return { failed: [] };
    },
    logger: {
      info: (_o: unknown, m: string) => logs.push(m),
      warn: () => {},
      error: (_o: unknown, m: string) => logs.push(m),
    },
    settleMs: 3000,
  });
  return {
    store,
    sent,
    logs,
    stop,
    tick: (ms: number) => {
      now += ms;
      vi.advanceTimersByTime(ms);
    },
  };
}

describe('handover push', () => {
  it('a burst of moves costs one push, carrying the last position', async () => {
    const r = rig();
    r.store.set('desk', { page: 'chat', id: 'a' }, 'desktop');
    r.tick(1000);
    r.store.set('desk', { page: 'chat', id: 'b' }, 'desktop');
    r.tick(1000);
    r.store.set('desk', { page: 'chat', id: 'c', seq: 9 }, 'desktop');
    r.tick(2999);
    expect(r.sent).toHaveLength(0);
    r.tick(1);
    await vi.runAllTimersAsync();
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.data).toMatchObject({
      kind: 'view_position',
      page: 'chat',
      id: 'c',
      seq: '9',
      surfaceKind: 'desktop',
    });
    // One token pushed once, even when a re-paired phone holds it twice.
    expect(r.sent[0]!.tokens.sort()).toEqual(['tok-phone', 'tok-tablet']);
    r.stop();
    vi.useRealTimers();
  });

  it('the phone that moved is not woken for its own move', async () => {
    const r = rig();
    r.store.set('tablet', { page: 'jobs' }, 'mobile');
    r.tick(3000);
    await vi.runAllTimersAsync();
    expect(r.sent[0]!.tokens).toEqual(['tok-phone']);
    r.stop();
    vi.useRealTimers();
  });

  it('nothing is pushed with sync off', async () => {
    const r = rig({ enabled: false });
    r.store.set('desk', { page: 'jobs' }, 'desktop');
    r.tick(5000);
    await vi.runAllTimersAsync();
    expect(r.sent).toHaveLength(0);
    r.stop();
    vi.useRealTimers();
  });

  it('a repeat of the same place pushes nothing', async () => {
    const r = rig();
    r.store.set('desk', { page: 'jobs' }, 'desktop');
    r.tick(3000);
    await vi.runAllTimersAsync();
    r.store.set('desk', { page: 'jobs' }, 'desktop');
    r.tick(5000);
    await vi.runAllTimersAsync();
    expect(r.sent).toHaveLength(1);
    r.stop();
    vi.useRealTimers();
  });

  it('push data is strings only', () => {
    const d = handoverPushData({ page: 'chat', id: 'x', seq: 3, surfaceId: 's', updatedAt: 5 });
    for (const v of Object.values(d)) expect(typeof v).toBe('string');
  });
});
