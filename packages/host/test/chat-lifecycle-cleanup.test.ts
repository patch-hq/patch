// Archiving, deleting and starting over must leave nothing of a chat's earlier
// life running or remembered:
//   - a goal verdict that arrives after the chat was archived must not
//     un-archive it with a continuation turn;
//   - soft-deleting stops the chat the way archiving does;
//   - a fresh user turn after the retry ladder ran out gets a fresh ladder, and
//     archiving forgets the overload backoff so the next overload starts at 5s.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  vi.useRealTimers();
});

function setup(backend: SdkBackend, extra: Partial<ConstructorParameters<typeof Daemon>[0]> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-lifecycle-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-lifecycle-folder-')));
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
    now: () => Date.now(),
    generateChatId: () => `chat-${++id}`,
    ...extra,
  });
  return { daemon, folder, events };
}

describe('a goal verdict that arrives after archiving', () => {
  it('is dropped: the chat stays archived and no continuation turn runs', async () => {
    let turns = 0;
    const backend: SdkBackend = {
      async *run() {
        turns += 1;
        yield { type: 'assistant', content: 'ok', sessionId: 'sess' };
        yield { type: 'result', sessionId: 'sess' };
      },
    };
    let release!: (v: { verdict: 'not_met'; reason: string }) => void;
    const verdict = new Promise<{ verdict: 'not_met'; reason: string }>((r) => (release = r));
    let evaluations = 0;
    // Only the first judgment is the held one; any later one ends the loop (null).
    const { daemon, folder } = setup(backend, {
      evaluateGoal: () => (++evaluations === 1 ? verdict : Promise.resolve(null)),
    });
    const chatId = await daemon.spawnChat({ folder });
    await tick();
    await daemon.setGoal(chatId, 'goal x');
    void daemon.sendInput({ chatId, message: 'hi', localId: 'u1', fromUser: true });
    await tick(80); // the turn has settled; the evaluator is in flight
    expect(turns).toBe(1);

    // Archiving waits for the pump, which is waiting on the evaluator.
    const archiving = daemon.setArchived(chatId, true);
    await tick(20);
    release({ verdict: 'not_met', reason: 'nope' });
    await archiving;
    await tick(80);

    expect(daemon.chatState.get(chatId)?.status).toBe('archived');
    expect(turns).toBe(1);
  });
});

describe('soft-deleting a chat', () => {
  it('stops the running turn and drops the queue, as archiving does', async () => {
    const prompts: string[] = [];
    const backend: SdkBackend = {
      run: async function* (opts) {
        prompts.push(opts.prompt);
        if (opts.prompt.includes('hang')) {
          await new Promise<void>((resolve) => {
            if (opts.abortController.signal.aborted) resolve();
            opts.abortController.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return;
        }
        yield { type: 'assistant', content: 'ok', sessionId: 'sess' };
        yield { type: 'result', sessionId: 'sess' };
      },
    };
    const { daemon, folder } = setup(backend);
    const chatId = await daemon.spawnChat({ folder });
    void daemon.sendInput({ chatId, message: 'hang on this', localId: 'L1', fromUser: true });
    await tick();
    void daemon.sendInput({ chatId, message: 'queued behind', localId: 'L2', fromUser: true });
    await tick();
    expect(daemon.chatState.get(chatId)?.activity).toBe('running');

    await daemon.setDeleted(chatId, true);
    await tick(60);

    expect(daemon.chatState.get(chatId)?.status).toBe('deleted');
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
    expect(prompts.filter((p) => p.includes('queued behind'))).toHaveLength(0);
  });
});

describe('the SDK retry ladder', () => {
  it('starts again for a new user message once the previous ladder ran out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let runs = 0;
    const backend: SdkBackend = {
      // eslint-disable-next-line require-yield
      async *run() {
        runs += 1;
        throw new Error('ECONNRESET');
      },
    };
    // A moving clock: the retry's idempotency key includes it.
    const { daemon, folder } = setup(backend);
    const chatId = await daemon.spawnChat({ folder, prompt: 'go' });
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(400_000); // the whole 10s + 30s + 90s ladder and past it
    expect(runs).toBe(4);

    await daemon.sendInput({ chatId, message: 'new', localId: 'u2', fromUser: true });
    await vi.advanceTimersByTimeAsync(400_000);
    // A fresh message gets its own ladder: itself plus three retries.
    expect(runs).toBe(8);
    daemon.shutdown();
  });
});
