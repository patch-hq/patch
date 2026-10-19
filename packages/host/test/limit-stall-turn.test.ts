// End to end through the daemon: the provider reports the window rejected and
// then the stream goes quiet. The turn must end as a limit failure on its own,
// within the grace period, rather than sitting `running`.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatErrorEvent, ChatStateEvent, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend, SdkEnvelope } from '../src/sdkBackend.js';

const NOW = 1_700_000_000_000;
const RESETS_AT = NOW + 3 * 3_600_000;
const GRACE = 60;

function setup(script: (n: number) => 'hang' | 'carry-on', autoResume = false) {
  const home = mkdtempSync(join(tmpdir(), 'patch-stall-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-stall-f-')));
  const events: WireEvent[] = [];
  const runs = { n: 0 };
  const backend: SdkBackend = {
    run: (): AsyncGenerator<SdkEnvelope> => {
      runs.n += 1;
      const mode = script(runs.n);
      async function* gen(): AsyncGenerator<SdkEnvelope> {
        yield {
          type: 'system',
          rateLimit: {
            scope: 'session',
            window: { status: 'rejected', utilization: 1, resetsAt: RESETS_AT },
          },
          raw: {},
        };
        if (mode === 'hang') await new Promise(() => undefined);
        yield { type: 'assistant', content: 'done', raw: {} };
        yield { type: 'result', sessionId: 's1', content: 'done', raw: {} };
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
    logger: pino({ level: 'silent' }),
    now: () => NOW,
    generateChatId: () => 'chat-1',
    limitStallGraceMs: GRACE,
  });
  if (autoResume) daemon.setAutoResumeRateLimit(true);
  return { daemon, events, folder, runs };
}

const errorsIn = (e: WireEvent[]): ChatErrorEvent[] =>
  e.filter((x): x is ChatErrorEvent => x.type === 'chat.error');
const statesIn = (e: WireEvent[]): ChatStateEvent[] =>
  e.filter((x): x is ChatStateEvent => x.type === 'chat.state');

describe('a turn that goes quiet after the provider rejects the window', () => {
  it('ends as a limit failure within the grace period instead of hanging', async () => {
    const { daemon, events, folder } = setup(() => 'hang');
    const chatId = await daemon.spawnChat({ folder });
    const started = Date.now();
    await daemon.sendInput({ chatId, message: 'go' });
    expect(Date.now() - started).toBeLessThan(GRACE + 2000);
    const errs = errorsIn(events);
    expect(errs).toHaveLength(1);
    expect(errs[0]?.error.message).toMatch(/usage limit reached/i);
    expect(daemon.chatState.get(chatId)?.activity).toBe('errored');
    daemon.shutdown();
  });

  it('parks the turn until the reset when auto-resume is on', async () => {
    const { daemon, events, folder, runs } = setup(() => 'hang', true);
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    expect(errorsIn(events)).toHaveLength(0);
    expect(statesIn(events).at(-1)?.rateLimitResumingAt).toBe(RESETS_AT);
    expect(runs.n).toBe(1);
    daemon.shutdown();
  });

  it('leaves a turn alone that carries on after the rejection', async () => {
    const { daemon, events, folder } = setup(() => 'carry-on');
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    expect(errorsIn(events)).toHaveLength(0);
    daemon.shutdown();
  });
});
