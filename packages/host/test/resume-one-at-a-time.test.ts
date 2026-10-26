// Parked turns go back ONE AT A TIME, and a provider refusal holds the line.
//
// 12 Oct 2026, 15:00 UTC. The Claude limit lifted and 34 parked turns were
// re-sent in a single tick — every chat parked on the same reset had a timer
// firing at the same instant, and the credit sweep released the rest. The box
// runs a few turns, not 34; most never got a session, and chats that had never
// completed a turn were resumed onto a session with no transcript and ended
// `errored` with their prompts dropped.
//
// A queue admits the next item when the one in front has settled, and not when
// the provider has merely refused it: feeding the next chat to a wall that has
// just refused the first only repeats the refusal N times.

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
const NO_RESET_SPEND_LIMIT =
  "Claude Code returned an error result: You've hit your monthly spend limit · " +
  'raise it at claude.ai/settings/usage?from=cc_cli_limit_message';

interface Probe {
  /** Refuse every run with the usage limit while true. */
  limited: boolean;
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
          if (probe.limited) throw limitError(NO_RESET_SPEND_LIMIT);
          yield { type: 'assistant', content: 'done', raw: {} };
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

async function parkChats(n: number) {
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
  });
  daemon.setAutoResumeRateLimit(true);
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
  it('runs them one at a time, in the order they were parked, and loses none', async () => {
    const { daemon, probe } = await parkChats(8);
    probe.limited = false;

    expect(daemon.resumeAllRateLimited()).toBe(8);
    await settle(800);

    expect(probe.peak).toBe(1);
    expect(probe.order).toEqual(Array.from({ length: 8 }, (_, i) => `turn-${i}`));
    expect(probe.completed).toHaveLength(8);
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

    // Credit returns, the line carries on from the FRONT, still one by one.
    probe.limited = false;
    probe.order.length = 0;
    daemon.resumeAllRateLimited();
    await settle(800);

    expect(probe.peak).toBe(1);
    expect(probe.order).toEqual(Array.from({ length: 6 }, (_, i) => `turn-${i}`));
    expect(probe.completed).toHaveLength(6);
    daemon.shutdown();
  });
});

describe('a turn resumed onto a session with no transcript', () => {
  const setup = () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-dead-session-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-dead-session-f-')));
    const seen: Array<{ prompt: string; resume: string | undefined }> = [];
    const mode = { limited: false };
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: {
        run: (opts): AsyncGenerator<SdkEnvelope> => {
          seen.push({ prompt: opts.prompt, resume: opts.resumeSessionId });
          async function* gen(): AsyncGenerator<SdkEnvelope> {
            if (mode.limited) throw limitError(NO_RESET_SPEND_LIMIT);
            // The session id the first attempt was handed never reached disk.
            if (opts.resumeSessionId !== undefined) {
              throw new Error(
                `Claude Code returned an error result: No conversation found with session ID: ${opts.resumeSessionId}`,
              );
            }
            yield { type: 'assistant', content: 'done', raw: {} };
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
    daemon.setAutoResumeRateLimit(true);
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
    // ran again with no session — the same prompt.
    expect(seen.map((s) => s.prompt)).toEqual(['owed turn', 'owed turn']);
    expect(seen[0]?.resume).toBe('sess-dead');
    expect(seen[1]?.resume).toBeUndefined();
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
            reseed: opts.claudeSessionStore?.reseed !== undefined,
          });
          async function* gen(): AsyncGenerator<SdkEnvelope> {
            if (limited) throw limitError(NO_RESET_SPEND_LIMIT);
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
    daemon.setAutoResumeRateLimit(true);
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
