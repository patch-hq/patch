// spec/04 § Goals — an agent cannot drop its own goal. It claims met or
// impossible and the goal judge has to agree; otherwise the goal stays.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

type Verdict = { verdict: 'met' | 'not_met' | 'impossible'; reason: string } | null;

async function setup(answer: Verdict) {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-goalclaim-')));
  let id = 0;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(mkdtempSync(join(tmpdir(), 'patch-goalclaim-home-'))),
    sdkBackend: createMockSdkBackend(),
    oauthAccessToken: 'fake-token',
    emit: () => {},
    logger: pino({ level: 'silent' }),
    now: () => Date.now(),
    generateChatId: () => `chat-${++id}`,
    evaluateGoal: (async () => answer) as never,
  });
  const chatId = await daemon.spawnChat({ folder });
  await daemon.setGoal(chatId, 'Ship it');
  return { daemon, chatId };
}

describe('claimGoalOutcome', () => {
  it('ends the goal only when the judge reaches the claimed verdict', async () => {
    const { daemon, chatId } = await setup({ verdict: 'met', reason: 'shipped' });
    const out = await daemon.claimGoalOutcome(chatId, 'met', 'it is shipped');
    expect(out.accepted).toBe(true);
    expect(daemon.chatState.get(chatId)?.goal).toBeNull();
    expect(daemon.chatState.get(chatId)?.lastGoal).toMatchObject({ outcome: 'met' });
  });

  it('keeps the goal and returns the judge reason when the judge disagrees', async () => {
    const { daemon, chatId } = await setup({ verdict: 'not_met', reason: 'nothing was shipped' });
    const out = await daemon.claimGoalOutcome(chatId, 'met', 'done');
    expect(out).toMatchObject({ accepted: false, reason: 'nothing was shipped' });
    expect(daemon.chatState.get(chatId)?.goal).toBe('Ship it');
  });

  it('keeps the goal when the judge gives no answer', async () => {
    const { daemon, chatId } = await setup(null);
    const out = await daemon.claimGoalOutcome(chatId, 'impossible', 'blocked');
    expect(out.accepted).toBe(false);
    expect(daemon.chatState.get(chatId)?.goal).toBe('Ship it');
  });
});
