// A closed-lid Mac on battery sleeps regardless of the sleep guard, and spends
// the night in seconds-long dark wakes. A turn started in one died when the Mac
// dropped back to sleep; the retry ladder spent its three rungs in the next
// three and left a 3am job errored by morning.
//
// Now a turn is held until the machine is fully awake (macOS says which wake it
// is in), and a turn the machine slept through goes round again, held the same
// way, without being reported as an error or taking a rung of the ladder.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatStateEvent, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';
import { createSleepWatch, type SleepWatch } from '../src/sleepWatch.js';

const silent = pino({ level: 'silent' });
const SLEPT =
  'Claude Code returned an error result: API Error: Your computer went to sleep mid-response.';

function failsThenSucceeds(errMsg: string, failures: number) {
  let calls = 0;
  const backend: SdkBackend = {
    async *run() {
      calls++;
      if (calls <= failures) throw new Error(errMsg);
    },
  };
  return { backend, calls: () => calls };
}

function fakeWatch(awake: { v: boolean }): SleepWatch {
  return {
    check: () => undefined,
    sleptSince: () => false,
    isFullyAwake: () => awake.v,
    dispose: () => undefined,
  };
}

function makeHost(backend: SdkBackend, sleepWatch: SleepWatch, tag: string) {
  const home = mkdtempSync(join(tmpdir(), `patch-${tag}-`));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), `patch-${tag}-f-`)));
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    hostId: `d-${tag}`,
    metaStore: createMetaStore(home),
    sdkBackend: backend,
    oauthAccessToken: 'fake',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => Date.now(),
    generateChatId: () => `chat-${tag}-${++id}`,
    sleepWatch,
  });
  return { daemon, folder, events };
}

const states = (events: WireEvent[]): ChatStateEvent[] =>
  events.filter((e): e is ChatStateEvent => e.type === 'chat.state');

describe('the wake gate', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds a turn through a dark wake, visibly, and runs it on a full wake', async () => {
    const awake = { v: false };
    const { backend, calls } = failsThenSucceeds('', 0);
    const { daemon, folder, events } = makeHost(backend, fakeWatch(awake), 'dark');
    void daemon.spawnChat({ folder, prompt: 'x' });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(calls()).toBe(0);
    expect(states(events).at(-1)?.waitingForWakeSince).toEqual(expect.any(Number));
    awake.v = true;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls()).toBe(1);
    expect(states(events).at(-1)?.waitingForWakeSince).toBeNull();
    daemon.shutdown();
  });

  it('a stop while the turn is held ends it, and it never runs', async () => {
    const awake = { v: false };
    const { backend, calls } = failsThenSucceeds('', 0);
    const { daemon, folder, events } = makeHost(backend, fakeWatch(awake), 'stop');
    void daemon.spawnChat({ folder, prompt: 'x' });
    await vi.advanceTimersByTimeAsync(30_000);
    const chatId = states(events).at(-1)!.chatId;
    await daemon.stopChat(chatId);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(states(events).at(-1)?.waitingForWakeSince).toBeNull();
    awake.v = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(0);
    daemon.shutdown();
  });

  it('a turn the machine slept through goes round again with no error and no rung spent', async () => {
    const { backend, calls } = failsThenSucceeds(SLEPT, 6);
    const { daemon, folder, events } = makeHost(backend, fakeWatch({ v: true }), 'slept');
    await daemon.spawnChat({ folder, prompt: 'x' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(7);
    expect(events.some((e) => e.type === 'chat.error')).toBe(false);
    expect(states(events).some((s) => s.activity === 'errored')).toBe(false);
    daemon.shutdown();
  });

  it('does not change how a failure with no sleep is retried', async () => {
    const { backend, calls } = failsThenSucceeds('API Error: 503 service unavailable', 99);
    const { daemon, folder } = makeHost(backend, fakeWatch({ v: true }), 'awake');
    await daemon.spawnChat({ folder, prompt: 'x' });
    await vi.advanceTimersByTimeAsync(400_000);
    expect(calls()).toBe(4);
    daemon.shutdown();
  });
});

describe('sleepWatch', () => {
  const FULL =
    'Current System Capabilities are: CPU Graphics Audio Network \nCurrent Power State: 4\n';
  const DARK = 'Current System Capabilities are: CPU Network Disk \nCurrent Power State: 4\n';

  it('reads a full wake from Graphics being among the capabilities', () => {
    let out = FULL;
    const w = createSleepWatch({ logger: silent, platform: 'darwin', readSystemState: () => out });
    expect(w.isFullyAwake()).toBe(true);
    out = DARK;
    expect(w.isFullyAwake()).toBe(false);
    w.dispose();
  });

  it('off macOS a long gap is a stall, named by whether the process was using the CPU, and reported to onGap', () => {
    vi.useFakeTimers();
    try {
      const error = vi.fn();
      const info = vi.fn();
      const logger = { ...silent, error, info } as unknown as pino.Logger;
      let clock = 1_000_000;
      let cpu = 0;
      const onGap = vi.fn();
      const w = createSleepWatch({
        logger,
        platform: 'linux',
        now: () => clock,
        cpuMs: () => cpu,
        onGap,
      });
      // An hour passes in which the process used almost no CPU: stopped, not busy.
      clock += 3_600_000;
      cpu += 50;
      w.check();
      expect(info).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledOnce();
      expect(error.mock.calls[0]?.[0]).toMatchObject({
        sleptMs: 3_600_000,
        cpuUsedMs: 50,
        kind: 'process stopped or starved',
      });
      expect(onGap).toHaveBeenCalledWith({ sleptMs: 3_600_000 });
      expect(w.sleptSince(1_000_000)).toBe(true);
      // The same gap spent spinning is a blocked event loop.
      clock += 3_600_000;
      cpu += 3_500_000;
      w.check();
      expect(error.mock.calls[1]?.[0]).toMatchObject({ kind: 'event loop blocked' });
      // An ordinary tick says nothing.
      clock += 5_000;
      w.check();
      expect(error).toHaveBeenCalledTimes(2);
      w.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is always awake off macOS', () => {
    const read = vi.fn(() => DARK);
    const w = createSleepWatch({ logger: silent, platform: 'linux', readSystemState: read });
    expect(w.isFullyAwake()).toBe(true);
    expect(read).not.toHaveBeenCalled();
    w.dispose();
  });

  it('says so loudly when it cannot read the wake state, and does not hold turns on it', () => {
    const error = vi.fn();
    const logger = { ...silent, error, info: vi.fn() } as unknown as pino.Logger;
    const w = createSleepWatch({
      logger,
      platform: 'darwin',
      readSystemState: () => {
        throw new Error('pmset missing');
      },
    });
    expect(w.isFullyAwake()).toBe(true);
    expect(error).toHaveBeenCalledOnce();
    w.dispose();
  });

  it('notices a tick that lands long after it was due', () => {
    let t = 1_000_000;
    const w = createSleepWatch({ logger: silent, now: () => t, tickMs: 5_000, gapMs: 30_000 });
    t += 5_000;
    w.check();
    expect(w.sleptSince(0)).toBe(false);
    const before = t;
    t += 20 * 60_000;
    w.check();
    expect(w.sleptSince(before)).toBe(true);
    expect(w.sleptSince(t)).toBe(false);
    w.dispose();
  });
});
