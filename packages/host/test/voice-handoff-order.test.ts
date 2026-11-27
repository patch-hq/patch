// spec/07 § The fast voice and the chat's agent — a hand-off is written into the
// chat when it is made, in order with what was said around it, not when the
// agent gets to it behind work already running.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';
import { createVoiceReplyBridge } from '../src/audio/replyBridge.js';

const silent = pino({ level: 'silent' });
const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));

function gatedBackend() {
  const gates: Array<() => void> = [];
  const prompts: string[] = [];
  const backend: SdkBackend = {
    async *run(opts): AsyncIterable<{ type: string; [k: string]: unknown }> {
      prompts.push(opts.prompt);
      await new Promise<void>((resolve) => gates.push(resolve));
      yield { type: 'result', sessionId: 'sess' };
      yield { type: 'assistant', content: `reply:${opts.prompt.slice(-12)}`, sessionId: 'sess' };
    },
  };
  return { backend, prompts, releaseNext: () => gates.shift()?.() };
}

function setup(backend: SdkBackend) {
  const home = mkdtempSync(join(tmpdir(), 'patch-vho-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-vhof-')));
  mkdirSync(folder, { recursive: true });
  const events: WireEvent[] = [];
  const bridge = createVoiceReplyBridge();
  let id = 0;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: backend,
    oauthAccessToken: 'fake-token',
    emit: (e) => {
      events.push(e);
      bridge.observe(e);
    },
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
    onDrawnTurnStarted: (chatId, localId) => bridge.turnStarted(chatId, localId),
  });
  return { daemon, events, folder, bridge };
}

describe('a voice hand-off behind a running turn', () => {
  it('is written where it was made, once, with no pending chip', async () => {
    const g = gatedBackend();
    const { daemon, events, folder, bridge } = setup(g.backend);
    const chatId = await daemon.spawnChat({ folder });
    void daemon.sendInput({ chatId, message: 'busy work', localId: 'L1' });
    await tick();

    const prefix = '[voice hand-off • web] ';
    const seq = daemon.recordVoiceMessage({
      chatId,
      role: 'user',
      content: `${prefix}check the build`,
      owed: false,
    });
    const reply = bridge.awaitReply(chatId, undefined, 'H1');
    void daemon.sendInput({
      chatId,
      message: 'check the build',
      localId: 'H1',
      voicePrefix: prefix,
      fromUser: true,
      deliverDrawn: seq,
    });
    // The voice keeps talking while the agent is busy: this lands after the hand-off line.
    const later = daemon.recordVoiceMessage({
      chatId,
      role: 'assistant',
      content: '[voice • web] Still on it.',
    });
    await tick();

    expect(
      events.some((e) => e.type === 'chat.queued' && (e as { localId: string }).localId === 'H1'),
    ).toBe(false);

    g.releaseNext();
    await tick();
    g.releaseNext();
    await expect(reply).resolves.toContain('reply:');

    const handoffLines = events.filter(
      (e) =>
        e.type === 'chat.message' &&
        (e as { content: string }).content.includes('check the build') &&
        (e as { role: string }).role === 'user',
    ) as Array<{ seq: number }>;
    expect(handoffLines).toHaveLength(1);
    expect(handoffLines[0]!.seq).toBe(seq);
    expect(seq).toBeLessThan(later);
    expect(g.prompts[1]).toContain('check the build');
    expect(
      events.some((e) => e.type === 'chat.dequeued' && (e as { localId: string }).localId === 'H1'),
    ).toBe(false);
  });
});

describe('reply bridge turnStarted', () => {
  it('arms only the waiter that asked for that localId', async () => {
    const bridge = createVoiceReplyBridge();
    let accepted = 0;
    const reply = bridge.awaitReply('c', undefined, 'mine', () => accepted++);
    bridge.turnStarted('c', 'other');
    expect(accepted).toBe(0);
    bridge.turnStarted('c', 'mine');
    expect(accepted).toBe(1);
    bridge.observe({
      type: 'chat.message',
      chatId: 'c',
      role: 'assistant',
      content: 'done',
      seq: 1,
    } as unknown as WireEvent);
    bridge.observe({
      type: 'chat.turn_ended',
      chatId: 'c',
      turnId: 't',
      seq: -1,
      at: 2,
      outcome: 'completed',
    } as unknown as WireEvent);
    await expect(reply).resolves.toBe('done');
  });
});
