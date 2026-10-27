// Editing a LATER user turn that was stopped before Claude persisted it
// (spec/04 § Branching). The turn is in Patch's own log, so the surface shows
// it and offers Edit, but it is missing from the session transcript. Its fork
// point is just after the event before it, which the transcript does hold.

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatBranchesEvent, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createHistoryReader } from '../src/history.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend, type SdkBackend, type SdkRunOptions } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-stopped-edit-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-stopped-edit-folder-'));
  const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-stopped-edit-projects-'));
  const mock = createMockSdkBackend({ claudeProjectsRoot: projectsRoot });
  // When `stall` is set, a turn persists nothing and waits to be stopped —
  // what a real turn looks like when Stop lands before Claude writes it.
  const ctl = { stall: false, runs: [] as SdkRunOptions[] };
  const sdk: SdkBackend = {
    run(opts) {
      ctl.runs.push(opts);
      if (!ctl.stall) return mock.run(opts);
      return (async function* () {
        await new Promise<void>((resolve) =>
          opts.abortController.signal.addEventListener('abort', () => resolve()),
        );
      })();
    },
  };
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: sdk,
    historyReader: createHistoryReader({ claudeProjectsRoot: projectsRoot }),
    oauthAccessToken: 'tok',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, ctl, events, folder };
}

function userTurns(daemon: Daemon, chatId: string): Array<{ seq: number; content: string }> {
  const out: WireEvent[] = [];
  daemon.replayChat(chatId, -1, (e) => out.push(e), undefined);
  return out
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

describe('spec/04 § Branching — editing a stopped turn Claude never persisted', () => {
  it('forks from just after the previous reply and keeps that conversation', async () => {
    const { daemon, ctl, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });

    ctl.stall = true;
    const running = daemon.sendInput({ chatId, message: 'second, stopped', localId: 'l2' });
    await new Promise((r) => setTimeout(r, 20));
    await daemon.stopChat(chatId);
    await running;
    ctl.stall = false;

    const stopped = userTurns(daemon, chatId).find((t) => t.content === 'second, stopped')!;
    events.length = 0;
    ctl.runs.length = 0;
    await daemon.forkChat({ chatId, seq: stopped.seq, message: 'second, fixed', localId: 'l3' });

    expect(errors(events)).toEqual([]);
    expect(branchCount(events)).toBe(2);
    // Resumes the parent session at the previous reply, not from empty.
    const fork = ctl.runs[0]?.fork;
    expect(fork).toBeDefined();
    expect(fork?.resumeAtUuid).not.toBeNull();
    expect(userTurns(daemon, chatId).map((t) => t.content)).toEqual([
      'first question',
      'second, fixed',
    ]);
  });

  it('still refuses a seq that is not a user turn', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });

    events.length = 0;
    await daemon.forkChat({ chatId, seq: 999, message: 'nope', localId: 'l2' });

    expect(errors(events)).toEqual(['fork_point_not_found']);
    expect(branchCount(events)).toBe(0);
  });
});
