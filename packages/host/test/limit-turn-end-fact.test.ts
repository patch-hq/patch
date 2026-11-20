// A turn that meets a limit is said on its end as a fact (spec/12 § Limits and
// sign-in): the account it ran on, the pool, the stated reset and the
// provider's own words. The server reads the account's state to decide whether
// the chat is paused, waiting for sign-in or out of credit; the host's frame
// says only that it still holds the owed turn (`limitNext`).

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
import { asServerSees } from './serverView.js';

const silent = pino({ level: 'silent' });
const NOW = Date.UTC(2023, 10, 14, 12, 0, 0);
const RESET = NOW + 2 * 3_600_000;
const LIMIT = 'Claude Code returned an error result: Session limit reached';

function setup(resetsAt: number | undefined) {
  const home = mkdtempSync(join(tmpdir(), 'patch-limit-fact-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-limit-fact-f-')));
  const events: WireEvent[] = [];
  const backend: SdkBackend = {
    run: (): AsyncGenerator<SdkEnvelope> => {
      async function* gen(): AsyncGenerator<SdkEnvelope> {
        throw limitError(LIMIT);
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
    generateChatId: () => 'chat-fact',
    nextAccountAfterExhausted: () => undefined,
    hostOutOfCredit: () => true,
    accountLimitInfo: () => ({
      label: 'Work',
      scope: 'session',
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    }),
  });
  daemon.setLimitBehaviour('resume_at_reset');
  return { daemon, events, folder };
}

const turnEnd = (events: WireEvent[]) =>
  events
    .filter(
      (e): e is Extract<WireEvent, { type: 'chat.turn_ended' }> => e.type === 'chat.turn_ended',
    )
    .at(-1);
const lastState = (events: WireEvent[]) =>
  asServerSees(events)
    .filter((e): e is Extract<WireEvent, { type: 'chat.state' }> => e.type === 'chat.state')
    .at(-1);

describe('a turn that meets a limit says so on its end', () => {
  it('carries the account, pool, reset and the provider words, and the host holds the turn', async () => {
    const { daemon, events, folder } = setup(RESET);
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    expect(turnEnd(events)?.limit).toEqual({
      accountId: 'a1',
      scope: 'session',
      resetsAt: RESET,
      message: LIMIT,
    });
    expect(lastState(events)?.limitNext).toBe('resume_at_reset');
    daemon.shutdown();
  });

  it('states no reset where none was stated', async () => {
    const { daemon, events, folder } = setup(undefined);
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go' });
    const limit = turnEnd(events)?.limit;
    expect(limit).toMatchObject({ accountId: 'a1', message: LIMIT });
    expect(limit?.resetsAt).toBeUndefined();
    expect(lastState(events)?.limitNext).toBe('ask');
    daemon.shutdown();
  });
});
