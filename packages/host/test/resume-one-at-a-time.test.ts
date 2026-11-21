// Parked turns go back STAGGERED, and a provider refusal holds the line.
//
// 12 Oct 2026, 15:00 UTC. The Claude limit lifted and 34 parked turns were
// re-sent in a single tick — every chat parked on the same reset had a timer
// firing at the same instant, and the credit sweep released the rest. The box
// runs a few turns, not 34; most never got a session, and chats that had never
// completed a turn were resumed onto a session with no transcript and ended
// `errored` with their prompts dropped.
//
// 20 Nov 2026. The fix for that admitted the next chat only when the one in
// front had FINISHED its whole turn. Agent turns run for tens of minutes: six
// chats released at 20:30 ran one after another, and at 22:10 the last was
// still shown paused on an account at 30% use.
//
// So the line admits the next chat once the one in front has got past the
// provider's limit check (its first model output, or its end, or a short wait
// with no refusal), never once its turn is over; and not when the provider has
// refused it again: feeding the next chat to a wall that has just refused the
// first only repeats the refusal N times.

import { transcriptFor } from './helpers/chatTranscript.js';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend, SdkEnvelope } from '../src/sdkBackend.js';
import { limitError } from './limitErrors.js';

const silent = pino({ level: 'silent' });
const NOW = Date.UTC(2023, 10, 14, 12, 0, 0);
// A TEMPORARY limit with a stated reset: the parks the host itself releases
// (`other_account`). An out-of-credit one waits for Continue (decision 25).
const RESETS_AT = NOW + 3_600_000;
const NO_RESET_SPEND_LIMIT =
  "Claude Code returned an error result: You've hit your monthly spend limit · " +
  'raise it at claude.ai/settings/usage?from=cc_cli_limit_message';

interface Probe {
  /** Refuse every run with the usage limit while true. */
  limited: boolean;
  /** Held open after its first output until released: a long agent turn. */
  longTurn?: { prompt: string; release: Promise<void> };
  /** Says nothing at all until released: a slow provider that has not refused. */
  silentTurn?: { prompt: string; release: Promise<void> };
  running: number;
  peak: number;
  order: string[];
  /** Prompts that ran to completion. */
  completed: string[];
}

function backend(probe: Probe): SdkBackend {
  return {
    run: (opts): AsyncGenerator<SdkEnvelope> => {
      async function* gen(): AsyncGenerator<SdkEnvelope> {
        probe.running += 1;
        probe.peak = Math.max(probe.peak, probe.running);
        probe.order.push(opts.prompt);
        try {
          // A real turn takes time; without this a serial and a parallel
          // release would be indistinguishable.
          await new Promise((r) => setTimeout(r, 5));
          if (probe.silentTurn?.prompt === opts.prompt) await probe.silentTurn.release;
          if (probe.limited) throw limitError(NO_RESET_SPEND_LIMIT, { resetsAt: RESETS_AT });
          yield { type: 'assistant', content: 'done', raw: {} };
          if (probe.longTurn?.prompt === opts.prompt) await probe.longTurn.release;
          yield { type: 'result', sessionId: `s-${opts.prompt}`, content: 'done', raw: {} };
          probe.completed.push(opts.prompt);
        } finally {
          probe.running -= 1;
        }
      }
      return gen();
    },
  };
}

async function parkChats(n: number, opts: { admitTimeoutMs?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-resume-line-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-resume-line-f-')));
  const probe: Probe = { limited: true, running: 0, peak: 0, order: [], completed: [] };
  let next = 0;
  let clock = 0;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: backend(probe),
    resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a1' }),
    emit: () => {},
    logger: silent,
    // Ticks, because a re-sent turn's id is built from the clock and a frozen
    // one would repeat an id the chat has already seen.
    now: () => NOW + clock++,
    generateChatId: () => `chat-${next++}`,
    nextAccountAfterExhausted: () => undefined,
    ...(opts.admitTimeoutMs !== undefined ? { resumeAdmitTimeoutMs: opts.admitTimeoutMs } : {}),
  });
  daemon.setLimitBehaviour('other_account');
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const chatId = await daemon.spawnChat({ folder });
    ids.push(chatId);
    await daemon.sendInput({ chatId, message: `turn-${i}` });
  }
  probe.order.length = 0;
  probe.peak = 0;
  return { daemon, probe, ids };
}

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

describe('resuming parked turns', () => {
  it('starts them in the order they were parked, never in one tick, and loses none', async () => {
    const { daemon, probe } = await parkChats(8);
    probe.limited = false;

    expect(daemon.resumeAllRateLimited()).toBe(8);
    // Staggered: the line has started only the first when the release returns.
    expect(probe.order).toEqual([]);
    await settle(800);

    expect(probe.order).toEqual(Array.from({ length: 8 }, (_, i) => `turn-${i}`));
    expect(probe.completed).toHaveLength(8);
    daemon.shutdown();
  });

  it('six chats on one account all start within seconds while the first runs a long turn', async () => {
    const { daemon, probe } = await parkChats(6);
    let finishFirst!: () => void;
    probe.longTurn = { prompt: 'turn-0', release: new Promise<void>((r) => (finishFirst = r)) };
    probe.limited = false;

    const t0 = Date.now();
    expect(daemon.resumeAllRateLimited()).toBe(6);
    for (let i = 0; i < 200 && probe.order.length < 6; i++) await settle(10);

    // Every owed turn has started, in order, though the first is still running.
    expect(probe.order).toEqual(Array.from({ length: 6 }, (_, i) => `turn-${i}`));
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(probe.completed).not.toContain('turn-0');
    expect(probe.peak).toBeGreaterThan(1);
    finishFirst();
    await settle();
    expect(probe.completed).toHaveLength(6);
    daemon.shutdown();
  });

  it('a turn that says nothing yet does not hold the line past the admit timeout', async () => {
    const { daemon, probe } = await parkChats(3, { admitTimeoutMs: 50 });
    probe.limited = false;
    let finish!: () => void;
    probe.silentTurn = { prompt: 'turn-0', release: new Promise<void>((r) => (finish = r)) };
    daemon.resumeAllRateLimited();
    await settle(400);
    expect(probe.order).toEqual(['turn-0', 'turn-1', 'turn-2']);
    finish();
    await settle();
    daemon.shutdown();
  });

  it('holds the whole line when the first turn is refused again, and keeps every turn', async () => {
    const { daemon, probe, ids } = await parkChats(6);

    // The provider is STILL refusing: only the first is tried.
    daemon.resumeAllRateLimited();
    await settle();
    expect(probe.order).toEqual(['turn-0']);
    expect(probe.completed).toHaveLength(0);

    // Nothing was dropped: all six are still owed.
    for (const chatId of ids) {
      expect(daemon.chatState.get(chatId)).toBeDefined();
    }

    // Credit returns, the line carries on from the FRONT, in order.
    probe.limited = false;
    probe.order.length = 0;
    daemon.resumeAllRateLimited();
    await settle(800);

    expect(probe.order).toEqual(Array.from({ length: 6 }, (_, i) => `turn-${i}`));
    expect(probe.completed).toHaveLength(6);
    daemon.shutdown();
  });
});

describe('a turn resumed onto a session with no transcript', () => {
  const setup = () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-dead-session-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-dead-session-f-')));
    const seen: Array<{ prompt: string; resume: string | undefined; reseed: boolean }> = [];
    const mode = { limited: false };
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: {
        run: (opts): AsyncGenerator<SdkEnvelope> => {
          seen.push({
            prompt: opts.prompt,
            resume: opts.resumeSessionId,
            reseed: transcriptFor(opts).length > 0,
          });
          async function* gen(): AsyncGenerator<SdkEnvelope> {
            if (mode.limited) throw limitError(NO_RESET_SPEND_LIMIT, { resetsAt: RESETS_AT });
            // The session id the first attempt was handed never reached disk.
            if (opts.resumeSessionId === 'sess-dead') {
              throw new Error(
                `Claude Code returned an error result: No conversation found with session ID: ${opts.resumeSessionId}`,
              );
            }
            yield {
              type: 'assistant',
              content: 'done',
              raw: { type: 'assistant', message: { usage: { input_tokens: 5 } } },
            };
            yield { type: 'result', sessionId: 'sess-dead', content: 'done', raw: {} };
          }
          return gen();
        },
      },
      resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a1' }),
      emit: () => {},
      logger: silent,
      now: (() => {
        let t = NOW;
        return () => (t += 1);
      })(),
      generateChatId: () => 'chat-dead',
      nextAccountAfterExhausted: () => undefined,
    });
    daemon.setLimitBehaviour('other_account');
    return { daemon, folder, seen, mode };
  };

  it('an OWED turn is re-sent as a fresh session instead of ending errored with its prompt dropped', async () => {
    const { daemon, folder, seen, mode } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first', localId: 'l1' });
    mode.limited = true;
    await daemon.sendInput({ chatId, message: 'owed turn', localId: 'l2' });
    mode.limited = false;
    seen.length = 0;

    daemon.resumeAllRateLimited();
    await settle();

    // The resume tried `sess-dead`, was told there is no such conversation, and
    // ran again on a fresh session — the same prompt.
    expect(seen.map((s) => s.prompt)).toEqual(['owed turn', 'owed turn']);
    expect(seen[0]?.resume).toBe('sess-dead');
    // The dead id is dropped and nothing is rebuilt (spec/04 § Resume): a fresh
    // session, with the record saying the model's memory ended there.
    expect(seen[1]?.resume).toBeUndefined();
    expect(seen[1]?.reseed).toBe(false);
    expect(daemon.chatState.get(chatId)?.activity).not.toBe('errored');
    daemon.shutdown();
  });

  it('a turn a person just typed still REPORTS a lost session (spec/04)', async () => {
    const { daemon, folder, seen } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first', localId: 'l1' });
    seen.length = 0;
    await daemon.sendInput({ chatId, message: 'typed', localId: 'l2' });

    expect(seen.map((s) => s.prompt)).toEqual(['typed']);
    expect(daemon.chatState.get(chatId)?.activity).toBe('errored');
    daemon.shutdown();
  });
});

describe('a chat that never answered anything', () => {
  it('is re-sent as a fresh session, not rebuilt into a session Claude cannot find', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-husk-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-husk-f-')));
    const runs: Array<{ resume: string | undefined; reseed: boolean }> = [];
    let limited = true;
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: {
        run: (opts): AsyncGenerator<SdkEnvelope> => {
          runs.push({
            resume: opts.resumeSessionId,
            reseed: transcriptFor(opts).length > 0,
          });
          async function* gen(): AsyncGenerator<SdkEnvelope> {
            if (limited) throw limitError(NO_RESET_SPEND_LIMIT, { resetsAt: RESETS_AT });
            yield { type: 'assistant', content: 'done', raw: {} };
            yield { type: 'result', sessionId: 'sess-ok', content: 'done', raw: {} };
          }
          return gen();
        },
      },
      resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a1' }),
      emit: () => {},
      logger: silent,
      now: (() => {
        let t = NOW;
        return () => (t += 1);
      })(),
      generateChatId: () => 'chat-husk',
      nextAccountAfterExhausted: () => undefined,
    });
    daemon.setLimitBehaviour('other_account');
    const chatId = await daemon.spawnChat({ folder });
    // Its first and only turn dies on the limit: a user prompt in the log, no answer.
    await daemon.sendInput({ chatId, message: 'the prompt', localId: 'l1' });
    limited = false;
    runs.length = 0;

    daemon.resumeAllRateLimited();
    await settle();

    expect(runs).toEqual([{ resume: undefined, reseed: false }]);
    expect(daemon.chatState.get(chatId)?.activity).not.toBe('errored');
    daemon.shutdown();
  });
});
