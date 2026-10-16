// spec/04 § Message delivery — a queued message is handed over when the agent's
// current tool call finishes. A tool call that never finishes (the agent is
// waiting for something to happen) must not hold it for ever: past the stall
// window the turn is interrupted and the message runs as its own turn.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });
const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** First turn starts a tool call and never returns it; later turns just reply. */
function hangingToolBackend(opts: { hang: boolean }) {
  const prompts: string[] = [];
  const backend: SdkBackend = {
    async *run(o): AsyncIterable<{ type: string; [k: string]: unknown }> {
      prompts.push(o.prompt);
      if (prompts.length === 1 && opts.hang) {
        yield { type: 'tool_use', tool: { name: 'Wait', args: {}, callId: 'c1' } };
        await new Promise<void>((resolve) =>
          o.abortController.signal.addEventListener('abort', () => resolve()),
        );
        return;
      }
      yield { type: 'assistant', content: `reply:${o.prompt}`, sessionId: 'sess' };
    },
  };
  return { backend, prompts };
}

function setup(backend: SdkBackend, clock: { t: number }) {
  const home = mkdtempSync(join(tmpdir(), 'patch-stall-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-sfolder-')));
  mkdirSync(folder, { recursive: true });
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: backend,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => clock.t,
    generateChatId: () => `chat-${++id}`,
    queuedStallMs: 1000,
    queuedStallSweepMs: 10,
  });
  return { daemon, events, folder };
}

describe('queued message behind a tool call that never returns', () => {
  it('interrupts the turn after the stall window and runs the message', async () => {
    const clock = { t: 1_700_000_000_000 };
    const b = hangingToolBackend({ hang: true });
    const { daemon, folder } = setup(b.backend, clock);
    const chatId = await daemon.spawnChat({ folder });

    void daemon.sendInput({ chatId, message: 'wait', localId: 'L1' });
    await tick();
    void daemon.sendInput({ chatId, message: 'hello?', localId: 'L2' });
    await tick(40);
    expect(b.prompts).toEqual(['wait']); // inside the window: still held

    clock.t += 1500;
    await tick(80);
    expect(b.prompts).toHaveLength(2);
    expect(b.prompts[1]).toContain('hello?');
    daemon.shutdown();
  });

  it('leaves the queue alone when no tool call is in flight', async () => {
    const clock = { t: 1_700_000_000_000 };
    const b = hangingToolBackend({ hang: false });
    const { daemon, folder } = setup(b.backend, clock);
    const chatId = await daemon.spawnChat({ folder });
    void daemon.sendInput({ chatId, message: 'one', localId: 'L1' });
    await tick(60);
    clock.t += 5000;
    await tick(40);
    expect(b.prompts).toEqual(['one']);
    daemon.shutdown();
  });
});
