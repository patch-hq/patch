// A closed-lid Mac on battery sleeps regardless of the sleep guard, and spends
// the night in seconds-long maintenance wakes. A turn dies in each one; the
// retry ladder used to spend its three rungs in the next three and leave a 3am
// job errored by morning. A turn the machine slept through is owed again once
// the machine is properly awake, and takes no rung of the ladder.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';
import { createSleepWatch, type SleepWatch } from '../src/sleepWatch.js';
import { SLEPT_THROUGH_MESSAGE } from '../src/failureCopy.js';

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

function fakeWatch(awakeMs: { v: number }): SleepWatch {
  return {
    check: () => undefined,
    sleptSince: () => false,
    awakeForMs: () => awakeMs.v,
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

describe('a turn the machine slept through', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is re-sent past the ladder ceiling and completes', async () => {
    const { backend, calls } = failsThenSucceeds(SLEPT, 6);
    const { daemon, folder } = makeHost(backend, fakeWatch({ v: 10 * 60_000 }), 'slept');
    await daemon.spawnChat({ folder, prompt: 'x' });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls()).toBe(7);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls()).toBe(7);
    daemon.shutdown();
  });

  it('tells the chat the machine slept, not what the provider said', async () => {
    const { backend } = failsThenSucceeds(SLEPT, 1);
    const { daemon, folder, events } = makeHost(backend, fakeWatch({ v: 10 * 60_000 }), 'said');
    await daemon.spawnChat({ folder, prompt: 'x' });
    await vi.advanceTimersByTimeAsync(1_000);
    const err = events.find((e) => e.type === 'chat.error');
    expect(err?.type === 'chat.error' && err.error.message).toBe(SLEPT_THROUGH_MESSAGE);
    daemon.shutdown();
  });

  it('waits until the machine has been awake a few minutes', async () => {
    const awake = { v: 20_000 };
    const { backend, calls } = failsThenSucceeds(SLEPT, 1);
    const { daemon, folder } = makeHost(backend, fakeWatch(awake), 'darkwake');
    await daemon.spawnChat({ folder, prompt: 'x' });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(calls()).toBe(1);
    awake.v = 5 * 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(2);
    daemon.shutdown();
  });

  it('does not change how a failure with no sleep is retried', async () => {
    const { backend, calls } = failsThenSucceeds('API Error: 503 service unavailable', 99);
    const { daemon, folder } = makeHost(backend, fakeWatch({ v: 10 * 60_000 }), 'awake');
    await daemon.spawnChat({ folder, prompt: 'x' });
    await vi.advanceTimersByTimeAsync(400_000);
    expect(calls()).toBe(4);
    daemon.shutdown();
  });
});

describe('sleepWatch', () => {
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
    expect(w.awakeForMs()).toBe(0);
    t += 4_000;
    w.check();
    expect(w.awakeForMs()).toBe(4_000);
    w.dispose();
  });
});
