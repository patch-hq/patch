// A subagent parked on a usage limit is paused, not failed: the host resumes it
// at the reset, so the parent must be told to wait, not that it is dead.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { TurnFailedError } from '../src/sdkBackend.js';
import type { SdkBackend } from '../src/sdkBackend.js';

const NOW = 1_700_000_000_000;
const RESETS_AT = NOW + 3 * 3_600_000;

const statedLimit = (): TurnFailedError =>
  new TurnFailedError('limit', {
    kind: 'rate_limit',
    status: 'rejected',
    rateLimitType: 'seven_day',
    resetsAt: RESETS_AT,
  });

async function flushUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('flushUntil: condition never became true');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('a subagent that hits a usage limit', () => {
  it('reports PAUSED with the local reset time, not FAILED, and stays running', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-delegate-limit-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-delegate-limit-f-')));
    const events: WireEvent[] = [];
    const backend: SdkBackend = {
      async *run(): AsyncIterable<never> {
        throw statedLimit();
      },
    };
    let n = 0;
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: backend,
      resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a1' }),
      emit: (e) => events.push(e),
      logger: pino({ level: 'silent' }),
      now: () => NOW,
      generateChatId: () => `chat-${++n}`,
      accountLimitInfo: () => ({ label: 'Work', scope: 'week' as const, resetsAt: RESETS_AT }),
      discoverClaudeMcpServers: () => [],
    });
    daemon.setAutoResumeRateLimit(true);
    const parentChatId = await daemon.spawnChat({ folder });
    const { id } = await daemon.createDelegate({ parentChatId, prompt: 'work' });

    const fromAgent = () =>
      events.filter(
        (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
          e.type === 'chat.message' && e.chatId === parentChatId && e.content.includes('; agent '),
      );
    await flushUntil(() => fromAgent().length > 0);
    const msg = fromAgent()[0]!.content;
    expect(msg).toContain('PAUSED');
    expect(msg).not.toContain('FAILED');
    expect(msg).toContain('Work');
    expect(msg).toContain(
      new Date(RESETS_AT).toLocaleString('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZoneName: 'short',
      }),
    );
    expect(daemon.listDelegates(parentChatId)).toEqual([
      expect.objectContaining({ id, status: 'running' }),
    ]);
    expect(fromAgent()).toHaveLength(1);
    daemon.shutdown();
  });
});
