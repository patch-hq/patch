// A snoozed chat must not come back before its wake time (spec/04 § Snooze).
// These pin the edges where a timer, a sweep or a restart could end a snooze
// early: a timer that fires ahead of the wall clock, a re-snooze that leaves
// the old timer behind, a clock that steps back, a snooze past setTimeout's
// ceiling, and the exact wake instant on hydrate.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { SNOOZE_UNTIL_COMPLETE, type WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { createHistoryReader } from '../src/history.js';

const silent = pino({ level: 'silent' });
const T0 = 1_700_000_000_000;
const MIN = 60_000;
const DAY = 86_400_000;

function setup(now: () => number, home?: string) {
  const dir = home ?? mkdtempSync(join(tmpdir(), 'patch-snooze-early-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-snooze-early-folder-')));
  const metaStore = createMetaStore(dir);
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore,
    sdkBackend: createMockSdkBackend(),
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now,
    generateChatId: () => `chat-${++id}`,
    historyReader: createHistoryReader({
      claudeProjectsRoot: mkdtempSync(join(tmpdir(), 'patch-snooze-early-claude-')),
    }),
  });
  return { daemon, events, folder, metaStore, dir };
}

const listed = (d: Daemon, chatId: string) => d.listWithFilter().some((c) => c.chatId === chatId);

afterEach(() => vi.useRealTimers());

describe('a snooze never ends before its wake time', () => {
  it('a timer that fires ahead of the wall clock leaves the chat snoozed, then wakes it on time', async () => {
    vi.useFakeTimers();
    let clock = T0;
    const { daemon, folder, metaStore } = setup(() => clock);
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setSnoozed(chatId, T0 + 10 * MIN);
    // The timer's clock reaches 10 min but the wall clock is 1ms short.
    clock = T0 + 10 * MIN - 1;
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(metaStore.read(chatId)?.snoozedUntil).toBe(T0 + 10 * MIN);
    expect(listed(daemon, chatId)).toBe(false);
    clock = T0 + 10 * MIN;
    await vi.advanceTimersByTimeAsync(1);
    expect(metaStore.read(chatId)?.snoozedUntil).toBe(null);
    expect(listed(daemon, chatId)).toBe(true);
    daemon.shutdown();
  });

  it('the wall-clock sweep does not wake a chat 1ms early, and does at the instant', async () => {
    vi.useFakeTimers();
    let clock = T0;
    const { daemon, folder, metaStore } = setup(() => clock);
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setSnoozed(chatId, T0 + 45_000);
    clock = T0 + 45_000 - 1;
    await vi.advanceTimersByTimeAsync(30_000); // one sweep tick, timer not yet due
    expect(metaStore.read(chatId)?.snoozedUntil).toBe(T0 + 45_000);
    clock = T0 + 45_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(metaStore.read(chatId)?.snoozedUntil).toBe(null);
    daemon.shutdown();
  });

  it('re-snoozing for longer leaves no earlier timer to end the new snooze', async () => {
    vi.useFakeTimers();
    let clock = T0;
    const { daemon, folder, metaStore } = setup(() => clock);
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setSnoozed(chatId, T0 + 5 * MIN);
    await daemon.setSnoozed(chatId, T0 + 60 * MIN);
    clock = T0 + 5 * MIN;
    await vi.advanceTimersByTimeAsync(5 * MIN + 31_000);
    expect(metaStore.read(chatId)?.snoozedUntil).toBe(T0 + 60 * MIN);
    expect(listed(daemon, chatId)).toBe(false);
    daemon.shutdown();
  });

  it('a wall clock that steps backwards after arming does not wake the chat early', async () => {
    vi.useFakeTimers();
    let clock = T0;
    const { daemon, folder, metaStore } = setup(() => clock);
    const chatId = await daemon.spawnChat({ folder });
    await daemon.setSnoozed(chatId, T0 + 10 * MIN);
    clock = T0 - 2 * 3_600_000; // NTP / manual correction
    await vi.advanceTimersByTimeAsync(10 * MIN + 31_000);
    expect(metaStore.read(chatId)?.snoozedUntil).toBe(T0 + 10 * MIN);
    clock = T0 + 10 * MIN;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(metaStore.read(chatId)?.snoozedUntil).toBe(null);
    daemon.shutdown();
  });

  it('a snooze longer than setTimeout can hold survives the first chunk and ends on the day', async () => {
    vi.useFakeTimers();
    let clock = T0;
    const { daemon, folder, metaStore } = setup(() => clock);
    const chatId = await daemon.spawnChat({ folder });
    const until = T0 + 40 * DAY;
    await daemon.setSnoozed(chatId, until);
    for (const days of [10, 24.9, 39.9]) {
      clock = T0 + days * DAY;
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(metaStore.read(chatId)?.snoozedUntil, `day ${days}`).toBe(until);
    }
    clock = until;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(metaStore.read(chatId)?.snoozedUntil).toBe(null);
    daemon.shutdown();
  });

  it('an until-complete snooze is never ended by the clock', async () => {
    vi.useFakeTimers();
    let clock = T0;
    const { daemon, folder, metaStore } = setup(() => clock);
    const chatId = await daemon.spawnChat({ folder });
    // Needs running work to be accepted; seed it via meta so the sweep sees the sentinel.
    daemon.chatState.get(chatId)!.snoozedUntil = SNOOZE_UNTIL_COMPLETE;
    metaStore.update(chatId, (m) => ({ ...m, snoozedUntil: SNOOZE_UNTIL_COMPLETE }));
    (daemon as unknown as { armSnoozeTimer(c: string, u: number): void }).armSnoozeTimer(
      chatId,
      SNOOZE_UNTIL_COMPLETE,
    );
    clock = T0 + 400 * DAY;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(daemon.chatState.get(chatId)?.snoozedUntil).toBe(SNOOZE_UNTIL_COMPLETE);
    daemon.shutdown();
  });

  it('hydrate keeps a snooze that ends 1ms from now and wakes one that ends exactly now', async () => {
    vi.useFakeTimers();
    let clock = T0;
    const first = setup(() => clock);
    const edge = await first.daemon.spawnChat({ folder: first.folder });
    const later = await first.daemon.spawnChat({ folder: first.folder });
    await first.daemon.setSnoozed(edge, T0 + MIN);
    await first.daemon.setSnoozed(later, T0 + MIN + 1);
    first.daemon.shutdown();

    clock = T0 + MIN;
    const second = setup(() => clock, first.dir);
    second.daemon.hydrate();
    expect(second.daemon.chatState.get(edge)?.snoozedUntil).toBe(null);
    expect(second.daemon.chatState.get(later)?.snoozedUntil).toBe(T0 + MIN + 1);
    expect(listed(second.daemon, later)).toBe(false);
    second.daemon.shutdown();
  });
});
