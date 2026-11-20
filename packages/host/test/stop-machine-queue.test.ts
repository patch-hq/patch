// A user Stop must end the turn the user was watching, not hand the chat
// straight on to a message another agent queued behind it.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';
import { asServerSees } from './serverView.js';

const tick = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

function setup() {
  const prompts: string[] = [];
  const backend: SdkBackend = {
    async *run(opts): AsyncIterable<{ type: string; [k: string]: unknown }> {
      prompts.push(opts.prompt);
      yield { type: 'result', sessionId: 'sess' };
      // Holds the turn open until it is aborted.
      await new Promise<void>((resolve) => {
        opts.abortController?.signal.addEventListener('abort', () => resolve());
        if (opts.abortController?.signal.aborted) resolve();
      });
      if (opts.abortController?.signal.aborted) throw new Error('aborted');
      yield { type: 'assistant', content: 'done', sessionId: 'sess' };
    },
  };
  const home = mkdtempSync(join(tmpdir(), 'patch-stopq-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-stopqf-')));
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: backend,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: pino({ level: 'silent' }),
    now: () => Date.now(),
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, folder, events, prompts };
}

describe('user stop with turns queued behind it', () => {
  it('cancels a queued message from another agent instead of running it', async () => {
    const { daemon, folder, events, prompts } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    const running = daemon.sendInput({ chatId, message: 'from Tom', localId: 'u1' });
    await tick();
    void daemon.sendInput({
      chatId,
      message: 'from another agent',
      localId: 'm1',
      origin: 'machine',
    });
    await tick();
    await daemon.stopAllBranches(chatId);
    await running;
    await tick();

    expect(prompts).toHaveLength(1);
    expect(
      events.some(
        (e) =>
          e.type === 'chat.dequeued' &&
          (e as { localId?: string }).localId === 'm1' &&
          (e as { reason?: string }).reason === 'cancelled',
      ),
    ).toBe(true);
    const last = [...asServerSees(events)]
      .reverse()
      .find((e) => e.type === 'chat.state' && e.chatId === chatId);
    expect((last as { activity?: string }).activity).toBe('idle');
  });

  it('keeps a message the user queued themselves', async () => {
    const { daemon, folder, prompts } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    const running = daemon.sendInput({ chatId, message: 'first', localId: 'u1' });
    await tick();
    void daemon.sendInput({ chatId, message: 'second', localId: 'u2' });
    await tick();
    await daemon.stopAllBranches(chatId);
    await tick();
    // The user's own queued turn went on to run after the first was stopped.
    expect(prompts).toHaveLength(2);
    await daemon.stopAllBranches(chatId);
    await running;
  });
});
