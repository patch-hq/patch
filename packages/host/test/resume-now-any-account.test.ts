// A chat paused on a usage limit that is locked to an account (a child agent
// inherits its parent's) re-ran on the same spent account after resume-now and
// parked again. Resuming by hand lifts the lock for that turn only.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { TurnFailedError } from '../src/sdkBackend.js';
import type { SdkBackend, SdkEnvelope } from '../src/sdkBackend.js';

const NOW = 1_700_000_000_000;
const RESETS_AT = NOW + 3 * 3_600_000;

async function flushUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('flushUntil: condition never became true');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('resume-now on a chat locked to a spent account', () => {
  it('asks for any account on the resumed turn, and drops the ask once the turn settles', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-resume-any-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-resume-any-f-')));
    let limited = true;
    const backend: SdkBackend = {
      async *run(): AsyncGenerator<SdkEnvelope> {
        if (limited) {
          throw new TurnFailedError('limit', {
            kind: 'rate_limit',
            status: 'rejected',
            rateLimitType: 'seven_day',
            resetsAt: RESETS_AT,
          });
        }
        yield { type: 'assistant', content: 'ok', raw: {} };
        yield { type: 'result', sessionId: 's1', content: 'ok', raw: {} };
      },
    };
    const asks: Array<boolean | undefined> = [];
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: backend,
      resolveOAuth: (_model, turn) => {
        if (turn) asks.push(turn.anyAccount);
        return { ok: true as const, accessToken: 'tok', accountId: 'default' };
      },
      emit: () => {},
      logger: pino({ level: 'silent' }),
      now: () => NOW,
      generateChatId: () => 'chat-1',
      accountLimitInfo: () => ({ label: 'Default', scope: 'week' as const, resetsAt: RESETS_AT }),
      discoverMcpServers: () => [],
    });
    daemon.setLimitBehaviour('resume_at_reset');
    const chatId = await daemon.spawnChat({ folder, preferredAccountId: 'default' });
    await daemon.sendInput({ chatId, message: 'work', localId: 'l1' });
    await flushUntil(() => asks.length >= 1);
    expect(asks[0]).toBeUndefined();
    await flushUntil(() => daemon.resumeRateLimitedNow(chatId) || false);

    limited = false;
    await flushUntil(() => asks.length >= 2);
    expect(asks.at(-1)).toBe(true);
    await flushUntil(() => !daemon.runsOnAnyAccount(chatId));
    daemon.shutdown();
  });
});
