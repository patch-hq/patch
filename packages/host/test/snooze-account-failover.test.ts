// A chat snoozed "until complete" must stay snoozed across an account failover:
// the turn that hit the limit is re-run on another account, so its work is not
// done. The brief idle between the failed run and the re-run used to wake it.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { SNOOZE_UNTIL_COMPLETE } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';
import { limitError } from './limitErrors.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SPEND_LIMIT =
  "Claude Code returned an error result: You've hit your monthly spend limit · " +
  'your weekly limit resets 8pm (UTC)';

describe('Snooze until complete across an account failover', () => {
  it('stays snoozed while the re-run on the next account is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    const backend: SdkBackend = {
      run: async function* () {
        runs += 1;
        if (runs === 1) {
          await sleep(80);
          throw limitError(SPEND_LIMIT);
        }
        await gate;
        yield { type: 'assistant', content: 'ok', sessionId: 's' };
        yield { type: 'result', sessionId: 's' };
      },
    };
    const home = mkdtempSync(join(tmpdir(), 'patch-snzfo-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-snzfo-f-')));
    mkdirSync(folder, { recursive: true });
    let id = 0;
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: backend,
      resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a' }),
      emit: () => {},
      logger: pino({ level: 'silent' }),
      now: () => 1_700_000_000_000,
      generateChatId: () => `chat-${++id}`,
      nextAccountAfterExhausted: () => 'b',
    });
    const chat = await daemon.spawnChat({ folder });
    void daemon.sendInput({ chatId: chat, message: 'go', localId: 'L1', origin: 'user' });
    await sleep(20);
    await daemon.setSnoozed(chat, SNOOZE_UNTIL_COMPLETE);

    await sleep(300); // failed run → failover → re-run now blocked on the gate
    expect(runs).toBe(2);
    expect(daemon.chatState.get(chat)?.snoozedUntil).toBe(SNOOZE_UNTIL_COMPLETE);

    release();
    await sleep(200);
    expect(daemon.chatState.get(chat)?.snoozedUntil).toBe(null);
    daemon.shutdown();
  });
});
