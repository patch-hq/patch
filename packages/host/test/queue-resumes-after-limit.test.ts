// Messages queued behind a turn that hits a usage limit are not lost, and run
// by themselves, in the order they were typed, once the limit lifts.
//
// Reported 12 Oct 2026: the subscription limit lifted and the model was usable
// again, but the queued messages never started — they had to be noticed and
// nudged by hand.

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend, SdkEnvelope } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });
const NOW = Date.UTC(2023, 10, 14, 12, 0, 0);
const LIMIT =
  "Claude Code returned an error result: You've hit your monthly spend limit · " +
  'raise it at claude.ai/settings/usage?from=cc_cli_limit_message · ' +
  'your weekly limit resets 9pm (Europe/London)';

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-queue-limit-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-queue-limit-f-')));
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const state = {
    limited: true,
    ran: [] as string[],
    release: undefined as (() => void) | undefined,
  };
  const gate = new Promise<void>((r) => (state.release = r));
  const sdkBackend: SdkBackend = {
    run: (input): AsyncGenerator<SdkEnvelope> => {
      const prompt = String((input as { prompt?: unknown }).prompt);
      async function* gen(): AsyncGenerator<SdkEnvelope> {
        if (state.ran.length === 0 && state.limited) await gate;
        if (state.limited) throw new Error(LIMIT);
        state.ran.push(prompt);
        yield { type: 'result', raw: {} };
      }
      return gen();
    },
  };
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore,
    sdkBackend,
    resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a1' }),
    emit: (e) => events.push(e),
    logger: silent,
    now: () => Date.now(),
    generateChatId: () => 'chat-q',
    nextAccountAfterExhausted: () => undefined,
  });
  daemon.setAutoResumeRateLimit(true);
  return { daemon, events, folder, metaStore, state };
}

describe('queue behind a usage limit', () => {
  it('keeps every queued message and runs them in order when the limit lifts', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { daemon, folder, metaStore, state } = setup();
      const chatId = await daemon.spawnChat({ folder });
      const first = daemon.sendInput({ chatId, message: 'one', localId: 'l1' });
      await daemon.sendInput({ chatId, message: 'two', localId: 'l2' });
      await daemon.sendInput({ chatId, message: 'three', localId: 'l3' });
      state.release?.();
      await first;
      await vi.advanceTimersByTimeAsync(0);

      // Limit hit: nothing ran, and all three are still owed on disk, in order.
      expect(state.ran).toEqual([]);
      const owed = metaStore.read(chatId)?.pendingTurns?.map((t) => t.message);
      expect(owed).toEqual(['one', 'two', 'three']);

      // The limit lifts and the stated reset time passes.
      state.limited = false;
      await vi.advanceTimersByTimeAsync(10 * 3600_000);
      await vi.advanceTimersByTimeAsync(0);

      const prompts = state.ran.map((p) => ['one', 'two', 'three'].find((m) => p.includes(m)));
      expect(prompts).toEqual(['one', 'two', 'three']);
      daemon.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
  it('a message typed while parked waits behind the parked ones instead of replacing them', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { daemon, folder, metaStore, state } = setup();
      const chatId = await daemon.spawnChat({ folder });
      const first = daemon.sendInput({ chatId, message: 'one', localId: 'l1' });
      state.release?.();
      await first;
      await daemon.sendInput({ chatId, message: 'two', localId: 'l2' });
      expect(metaStore.read(chatId)?.pendingTurns?.map((t) => t.message)).toEqual(['one', 'two']);

      state.limited = false;
      await vi.advanceTimersByTimeAsync(10 * 3600_000);
      await vi.advanceTimersByTimeAsync(0);
      const prompts = state.ran.map((p) => ['one', 'two'].find((m) => p.includes(m)));
      expect(prompts).toEqual(['one', 'two']);
      daemon.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
  it('a message typed while parked retries the owed turn now instead of waiting for the timer', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { daemon, folder, state } = setup();
      const chatId = await daemon.spawnChat({ folder });
      const first = daemon.sendInput({ chatId, message: 'one', localId: 'l1' });
      state.release?.();
      await first;

      // The situation changed (another account, credit back); no timer has fired.
      state.limited = false;
      await daemon.sendInput({ chatId, message: 'two', localId: 'l2' });
      await vi.advanceTimersByTimeAsync(0);

      const prompts = state.ran.map((p) => ['one', 'two'].find((m) => p.includes(m)));
      expect(prompts).toEqual(['one', 'two']);
      daemon.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});
