// The limit card and the resume timer must read the SAME reset.
//
// 27 Oct 2026: a chat showed "Session limit reset · Default · 1 min ago ·
// Message not sent" with Auto-resume ticked, and nothing ever ran. The card's
// reset comes from the account's own window (`accountLimitInfo`), but the timer
// was armed only from the failure's text and the per-scope readings. A refusal
// that stated no reset, on a host with no credit anywhere, therefore armed
// nothing — while the card counted down to a reset that then passed with no
// resume behind it.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { limitError } from './limitErrors.js';
import type { SdkBackend, SdkEnvelope } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });
const NOW = Date.UTC(2023, 10, 14, 12, 0, 0);
const ACCOUNT_RESET = NOW + 3 * 3_600_000;
const NO_RESET =
  "Claude Code returned an error result: You've hit your monthly spend limit · " +
  'raise it at claude.ai/settings/usage?from=cc_cli_limit_message';

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-card-reset-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-card-reset-f-')));
  const events: WireEvent[] = [];
  const backend: SdkBackend = {
    run: (): AsyncGenerator<SdkEnvelope> => {
      async function* gen(): AsyncGenerator<SdkEnvelope> {
        throw limitError(NO_RESET);
        yield { type: 'result', raw: {} };
      }
      return gen();
    },
  };
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: backend,
    resolveOAuth: () => ({ ok: true as const, accessToken: 'tok', accountId: 'a1' }),
    emit: (e) => events.push(e),
    logger: silent,
    now: () => NOW,
    generateChatId: () => 'chat-card',
    nextAccountAfterExhausted: () => undefined,
    hostOutOfCredit: () => true,
    accountLimitInfo: () => ({ label: 'Default', scope: 'session', resetsAt: ACCOUNT_RESET }),
  });
  daemon.setAutoResumeRateLimit(true);
  return { daemon, events, folder };
}

describe('the reset the card shows is the reset the resume is armed for', () => {
  it('arms the auto-resume at the account window reset when the failure states none', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });

    const state = events
      .filter((e): e is Extract<WireEvent, { type: 'chat.state' }> => e.type === 'chat.state')
      .at(-1);
    expect(state?.limitBlock?.resetsAt).toBe(ACCOUNT_RESET);
    expect(state?.rateLimitResumingAt).toBe(ACCOUNT_RESET);
    daemon.shutdown();
  });
});
