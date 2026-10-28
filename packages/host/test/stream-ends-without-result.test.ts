// A turn whose model stream closes without the provider's final `result` was
// recorded as completed, so a dropped connection ended the turn in silence with
// the work half done. It is a failure: the chat says so and the retry ladder
// runs it again.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatErrorEvent, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function makeHost(backend: SdkBackend) {
  const home = mkdtempSync(join(tmpdir(), 'patch-noresult-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-noresult-f-')));
  const events: WireEvent[] = [];
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: backend,
    oauthAccessToken: 'tok',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => Date.now(),
  });
  return { daemon, folder, events };
}

const errors = (events: WireEvent[]) =>
  events.filter((e): e is ChatErrorEvent => e.type === 'chat.error');

describe('a stream that ends without a result', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reports an error instead of completing, and retries the turn', async () => {
    let calls = 0;
    const backend: SdkBackend = {
      async *run() {
        calls++;
        yield { type: 'assistant', content: 'half done', sessionId: 'S' };
      },
    };
    const { daemon, folder, events } = makeHost(backend);
    await daemon.spawnChat({ folder, prompt: 'x' });
    await vi.advanceTimersByTimeAsync(400_000);
    expect(errors(events)[0]?.error.message).toMatch(/ended before the turn finished/);
    expect(calls).toBeGreaterThan(1);
    daemon.shutdown();
  });

  it('completes normally when the stream ends with its result', async () => {
    const backend: SdkBackend = {
      async *run() {
        yield { type: 'assistant', content: 'done', sessionId: 'S' };
        yield { type: 'result', sessionId: 'S' };
      },
    };
    const { daemon, folder, events } = makeHost(backend);
    await daemon.spawnChat({ folder, prompt: 'x' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(errors(events)).toHaveLength(0);
    daemon.shutdown();
  });
});
