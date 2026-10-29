// A host short of memory holds new turns (queued, not started) and runs them,
// in order, once memory recovers — rather than start work that would be cut off.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const waitFor = (cond: () => boolean, ms = 3000): Promise<void> =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = (): void => {
      if (cond()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('waitFor: condition never held'));
      setTimeout(poll, 5);
    };
    poll();
  });

describe('holding turns while memory is critical', () => {
  it('queues new turns, then runs them in order on release', async () => {
    let critical = true;
    const events: WireEvent[] = [];
    const prompts: string[] = [];
    const backend = createMockSdkBackend();
    const run = backend.run.bind(backend);
    backend.run = (opts) => {
      prompts.push(opts.prompt);
      return run(opts);
    };
    let id = 0;
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(mkdtempSync(join(tmpdir(), 'patch-hold-'))),
      sdkBackend: backend,
      oauthAccessToken: 'fake-token',
      emit: (e) => events.push(e),
      logger: pino({ level: 'silent' }),
      now: () => 1_700_000_000_000,
      generateChatId: () => `chat-${++id}`,
      holdTurns: () => critical,
    });
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-holdf-')));
    const chatId = await daemon.spawnChat({ folder });

    await daemon.sendInput({ chatId, message: 'one', localId: 'L1' });
    await daemon.sendInput({ chatId, message: 'two', localId: 'L2' });
    expect(prompts).toEqual([]);
    expect(
      events.filter((e) => e.type === 'chat.queued').map((e) => (e as { localId: string }).localId),
    ).toEqual(['L1', 'L2']);

    critical = false;
    daemon.releaseHeldTurns();
    await waitFor(() => prompts.length === 2);
    expect(prompts.map((p) => p.includes('one') || p.includes('two'))).toEqual([true, true]);
    expect(prompts[0]).toContain('one');
    expect(prompts[1]).toContain('two');
  });
});
