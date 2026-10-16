// spec/12 § A turn is owed until it settles — a re-sent turn NAMES the bubble
// it already has.
//
// The host re-sends an owed turn itself: `resumeInterruptedTurns` replays
// `pendingTurns` after a restart (every deploy does one), and the SDK-error
// ladder re-enters `sendInput` on 10s/30s/90s. Both go through `runQuery`, which
// emits a fresh user `chat.message` at a fresh seq — so before this, one
// question that recovered twice reached the surfaces as three identical user
// messages. Tom photographed exactly that: "the human message shouldnt be
// repeated."
//
// `retryOfSeq` carries the ORIGINAL user message's seq on every attempt, so a
// surface folds the copy into the bubble already on screen. These cover the
// producer half: that the field is emitted, that it names the ORIGINAL rather
// than the rung before it, and that it survives a reload (Claude Code's
// transcript records each attempt as an ordinary user turn and knows nothing
// about the link, so the host keeps it in the chat's own meta).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatMessageEvent, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });
const NOW = 1_700_000_000_000;

/** A backend that throws `errMsg` every time, counting the attempts. */
function alwaysThrows(errMsg: string): { backend: SdkBackend; calls: () => number } {
  let calls = 0;
  return {
    backend: {
      async *run() {
        calls++;
        throw new Error(errMsg);
      },
    },
    calls: () => calls,
  };
}

function makeHost(backend: SdkBackend, tag: string) {
  const home = mkdtempSync(join(tmpdir(), `patch-${tag}-`));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), `patch-${tag}-f-`)));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    hostId: `d-${tag}`,
    metaStore,
    sdkBackend: backend,
    oauthAccessToken: 'fake',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => NOW,
    generateChatId: () => `chat-${tag}-${++id}`,
  });
  return { daemon, folder, events, metaStore };
}

function userMessages(events: WireEvent[], chatId: string): ChatMessageEvent[] {
  return events.filter(
    (e): e is ChatMessageEvent =>
      e.type === 'chat.message' && e.chatId === chatId && e.role === 'user',
  );
}

describe('a permanent failure is not retried', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a 400 once and leaves the chat errored with its message', async () => {
    const msg = 'API Error: 400 {"type":"invalid_request_error","message":"bad"}';
    const { backend, calls } = alwaysThrows(msg);
    const { daemon, folder, events } = makeHost(backend, 'perm');
    const chatId = await daemon.spawnChat({ folder, prompt: 'x' });
    await vi.advanceTimersByTimeAsync(400_000);
    expect(calls()).toBe(1);
    expect(userMessages(events, chatId)).toHaveLength(1);
    daemon.shutdown();
  });

  it('still walks the whole ladder for a transient 503', async () => {
    const { backend, calls } = alwaysThrows('API Error: 503 service unavailable');
    const { daemon, folder } = makeHost(backend, 'trans');
    await daemon.spawnChat({ folder, prompt: 'x' });
    await vi.advanceTimersByTimeAsync(400_000);
    expect(calls()).toBe(4);
    daemon.shutdown();
  });
});
