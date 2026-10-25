// Snooze visibility on the server (spec/04 § Snooze) at the instants where a
// chat could surface early or in two places: the exact wake millisecond, a
// snooze that moves later, an unsnooze, and a snooze that is not on an
// `active` chat. Every surface reads the same registry, so these are what the
// "cross-device" view of a snooze is made of.

import { describe, it, expect } from 'vitest';
import { SNOOZE_UNTIL_COMPLETE } from '@patch/wire';
import { ChatRegistry } from '../src/chat-registry.js';

const T0 = 1_700_000_000_000;

function reg(now: () => number): ChatRegistry {
  const r = new ChatRegistry({ logger: { warn: () => undefined }, now });
  r.observe({ type: 'chat.spawned', hostId: 'd1', chatId: 'c1', folder: '/x' });
  return r;
}

function state(r: ChatRegistry, extra: Record<string, unknown>, lastUpdated = 1): void {
  r.observe({
    type: 'chat.state',
    permissionMode: 'bypassPermissions',
    chatId: 'c1',
    activity: 'idle',
    lastUpdated,
    status: 'active',
    folder: '/x',
    ...extra,
  } as Parameters<ChatRegistry['observe']>[0]);
}

const active = (r: ChatRegistry) => r.list().map((c) => c.chatId);
const snoozed = (r: ChatRegistry) => r.list({ snoozedOnly: true }).map((c) => c.chatId);

describe('ChatRegistry snooze boundaries', () => {
  it('is snoozed up to the millisecond before the wake time and active at it', () => {
    let now = T0;
    const r = reg(() => now);
    state(r, { snoozedUntil: T0 + 1000 });
    now = T0 + 999;
    expect(active(r)).toEqual([]);
    expect(snoozed(r)).toEqual(['c1']);
    now = T0 + 1000;
    expect(active(r)).toEqual(['c1']);
    expect(snoozed(r)).toEqual([]);
  });

  it('never appears in both the active and snoozed views', () => {
    let now = T0;
    const r = reg(() => now);
    state(r, { snoozedUntil: T0 + 5000 });
    for (now = T0 - 1000; now <= T0 + 6000; now += 250) {
      const a = active(r).includes('c1');
      const s = snoozed(r).includes('c1');
      expect(a !== s, `at +${now - T0}`).toBe(true);
    }
  });

  it('a snooze moved later (from another device) hides a chat that had come back', () => {
    let now = T0;
    const r = reg(() => now);
    state(r, { snoozedUntil: T0 + 1000 });
    now = T0 + 2000;
    expect(active(r)).toEqual(['c1']);
    state(r, { snoozedUntil: T0 + 60_000 }, 2);
    expect(active(r)).toEqual([]);
  });

  it('an unsnooze from another device brings the chat back at once, before the old wake time', () => {
    const r = reg(() => T0);
    state(r, { snoozedUntil: T0 + 3_600_000 });
    expect(active(r)).toEqual([]);
    state(r, { snoozedUntil: null }, 2);
    expect(active(r)).toEqual(['c1']);
    expect(r.get('c1')?.snoozedUntil).toBe(null);
  });

  it('an until-complete snooze stays hidden however far the clock moves', () => {
    let now = T0;
    const r = reg(() => now);
    state(r, { snoozedUntil: SNOOZE_UNTIL_COMPLETE });
    now = T0 + 5 * 365 * 86_400_000;
    expect(active(r)).toEqual([]);
    expect(snoozed(r)).toEqual(['c1']);
  });

  it('later events without the field, or with other fields changing, keep the snooze', () => {
    const r = reg(() => T0);
    state(r, { snoozedUntil: T0 + 60_000 });
    state(r, { activity: 'running' }, 2);
    state(r, { name: 'renamed' }, 3);
    expect(r.get('c1')?.snoozedUntil).toBe(T0 + 60_000);
    expect(active(r)).toEqual([]);
  });

  it('a snoozed chat that is archived is not listed as snoozed', () => {
    const r = reg(() => T0);
    state(r, { snoozedUntil: T0 + 60_000, status: 'archived' }, 2);
    expect(snoozed(r)).toEqual([]);
  });
});
