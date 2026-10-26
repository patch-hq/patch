// Editing the FIRST user message of a chat (spec/04 § Branching). The fork
// point of the first turn is "an empty context", the edge case every later turn
// avoids, so it gets its own suite: completed, stopped, and still-running first
// turns, each edited once and then again.

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatBranchesEvent, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createHistoryReader } from '../src/history.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function setup(opts: { turnDelayMs?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-first-edit-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-first-edit-folder-'));
  const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-first-edit-projects-'));
  const sdk = createMockSdkBackend({
    claudeProjectsRoot: projectsRoot,
    ...(opts.turnDelayMs !== undefined ? { turnDelayMs: opts.turnDelayMs } : {}),
  });
  const events: WireEvent[] = [];
  const metaStore = createMetaStore(home);
  let id = 0;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore,
    sdkBackend: sdk,
    historyReader: createHistoryReader({ claudeProjectsRoot: projectsRoot }),
    oauthAccessToken: 'tok',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, sdk, events, folder, metaStore };
}

function replay(daemon: Daemon, chatId: string): WireEvent[] {
  const out: WireEvent[] = [];
  daemon.replayChat(chatId, -1, (e) => out.push(e), undefined);
  return out;
}

function userMessages(events: WireEvent[]): Array<{ seq: number; content: string }> {
  return events
    .filter(
      (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
        e.type === 'chat.message' && e.role === 'user',
    )
    .map((e) => ({ seq: e.seq, content: e.content }));
}

function errors(events: WireEvent[]): string[] {
  return events
    .filter((e) => e.type === 'chat.error')
    .map((e) => (e as { error: { code: string } }).error.code);
}

function branchCount(events: WireEvent[]): number {
  const all = events.filter((e): e is ChatBranchesEvent => e.type === 'chat.branches');
  return all[all.length - 1]?.branches.length ?? 0;
}

describe('spec/04 § Branching — editing the first message', () => {
  it('a completed first turn can be edited: new track starts from an empty context', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const first = userMessages(replay(daemon, chatId))[0]!;

    events.length = 0;
    await daemon.forkChat({ chatId, seq: first.seq, message: 'first, rephrased', localId: 'l2' });

    expect(errors(events)).toEqual([]);
    expect(branchCount(events)).toBe(2);
    const after = userMessages(replay(daemon, chatId)).map((m) => m.content);
    expect(after).toEqual(['first, rephrased']);
  });

  it('the first message can be edited more than once', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const first = userMessages(replay(daemon, chatId))[0]!;
    await daemon.forkChat({ chatId, seq: first.seq, message: 'edit one', localId: 'l2' });

    const edited = userMessages(replay(daemon, chatId))[0]!;
    events.length = 0;
    await daemon.forkChat({ chatId, seq: edited.seq, message: 'edit two', localId: 'l3' });

    expect(errors(events)).toEqual([]);
    expect(branchCount(events)).toBe(3);
    expect(userMessages(replay(daemon, chatId)).map((m) => m.content)).toEqual(['edit two']);
  });

  it('the edit starts a session of its own, resuming nothing from the original', async () => {
    const { daemon, sdk, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const first = userMessages(replay(daemon, chatId))[0]!;

    await daemon.forkChat({ chatId, seq: first.seq, message: 'first, rephrased', localId: 'l2' });

    // Resuming the parent here would carry the original first message and its
    // whole conversation into the "empty" track.
    expect(sdk.lastOptions()?.resumeSessionId).toBeUndefined();
  });

  it('a first turn stopped before Claude made a session can still be edited', async () => {
    const { daemon, events, folder } = setup({ turnDelayMs: 200 });
    const chatId = await daemon.spawnChat({ folder });
    const running = daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    await daemon.stopChat(chatId);
    await running;

    // Nothing was persisted, so the surface still shows the message at seq 0.
    events.length = 0;
    await daemon.forkChat({ chatId, seq: 0, message: 'first, rephrased', localId: 'l2' });

    expect(errors(events)).toEqual([]);
    expect(branchCount(events)).toBe(2);
    expect(userMessages(replay(daemon, chatId)).map((m) => m.content)).toEqual([
      'first, rephrased',
    ]);
  });

  it('a stopped chat with no session still refuses a seq that is not its first turn', async () => {
    const { daemon, events, folder } = setup({ turnDelayMs: 200 });
    const chatId = await daemon.spawnChat({ folder });
    const running = daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    await daemon.stopChat(chatId);
    await running;

    events.length = 0;
    await daemon.forkChat({ chatId, seq: 5, message: 'nope', localId: 'l2' });

    expect(errors(events)).toEqual(['fork_point_not_found']);
    expect(branchCount(events)).toBe(0);
  });
});
