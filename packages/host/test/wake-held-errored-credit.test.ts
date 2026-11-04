// A loop's wake must not be delivered into a chat that ERRORED on a spent
// account. Before, only parked chats counted as limited, so every tick landed
// in the errored chat, the wakes stacked, and all replayed when credit came
// back — the agent saw a pile of identical [wake] turns and cancelled its loop.

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend, SdkEnvelope } from '../src/sdkBackend.js';
import { limitError } from './limitErrors.js';

const silent = pino({ level: 'silent' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('wake into a chat errored on credit', () => {
  it('is held, not delivered as a new turn', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-wake-err-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-wake-err-f-')));
    mkdirSync(folder, { recursive: true });
    const runs = { n: 0 };
    const backend: SdkBackend = {
      run: (): AsyncGenerator<SdkEnvelope> => {
        runs.n += 1;
        async function* gen(): AsyncGenerator<SdkEnvelope> {
          throw limitError(
            "Claude Code returned an error result: You've hit your monthly spend limit",
          );
        }
        return gen();
      },
    } as unknown as SdkBackend;
    const daemon = new Daemon({
      hostId: 'd-wake-err',
      metaStore: createMetaStore(home),
      sdkBackend: backend,
      resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a1' }),
      emit: () => undefined,
      logger: silent,
      now: () => Date.now(),
      generateChatId: () => 'chat-wake-err',
    });
    daemon.setAutoResumeRateLimit(false);
    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await sleep(80);
    // The errored-only shape: failed on credit, with no park or timer left
    // (a park lost to a restart, or retries spent).
    const internals = daemon as unknown as {
      rateLimitTimers: Map<string, ReturnType<typeof setTimeout>>;
      rateLimitPendingTurns: Map<string, unknown>;
      limitBlocks: Map<string, unknown>;
    };
    for (const t of internals.rateLimitTimers.values()) clearTimeout(t);
    internals.rateLimitTimers.clear();
    internals.rateLimitPendingTurns.clear();
    internals.limitBlocks.clear();
    const before = runs.n;
    expect(before).toBeGreaterThan(0);

    daemon.scheduleWake(chatId, { in: '0', message: 'tick' });
    await sleep(80);

    expect(runs.n).toBe(before);
    expect(daemon.peekWake(chatId)).not.toBeNull();
    daemon.shutdown();
  });
});
