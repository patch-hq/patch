// spec/04 § Branching (edit / fork a message) — a chat is a GRAPH, not a line.
// Editing a user turn forks a new TRACK from that turn: the prefix is shared,
// the original track is left intact, and the user switches between them.
//
// The fork point comes from the chat's own record: the provider id
// (`nativeRef`) each entry carries. Driven against the mock SDK backend, which
// gives each entry an id as the real SDK does and forks its session file at
// one.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { ChatBranchesEvent, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createClaudeSessionProbe } from '../src/history.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { readBack } from './helpers/readBack.js';

const silent = pino({ level: 'silent' });

function setup(opts: { turnDelayMs?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-branch-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-branch-folder-'));
  mkdirSync(folder, { recursive: true });
  const projectsRoot = mkdtempSync(join(tmpdir(), 'patch-branch-projects-'));
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
    sessionProbe: createClaudeSessionProbe({ claudeProjectsRoot: projectsRoot }),
    oauthAccessToken: 'tok',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, sdk, events, folder, metaStore, home, projectsRoot };
}

function branchEvents(events: WireEvent[]): ChatBranchesEvent[] {
  return events.filter((e): e is ChatBranchesEvent => e.type === 'chat.branches');
}

function lastBranches(events: WireEvent[]): ChatBranchesEvent {
  const all = branchEvents(events);
  const last = all[all.length - 1];
  if (!last) throw new Error('no chat.branches event emitted');
  return last;
}

/** The replayed transcript, as the surface would see it. */
function replay(daemon: Daemon, chatId: string, branchId?: string): WireEvent[] {
  return readBack(daemon, chatId, branchId !== undefined ? { branchId } : {});
}

function userMessages(events: WireEvent[]): Array<{ seq: number; content: string }> {
  return events
    .filter(
      (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
        e.type === 'chat.message' && e.role === 'user',
    )
    .map((e) => ({ seq: e.seq, content: e.content }));
}

describe('spec/04 § Branching — edit a user turn forks a new track', () => {
  it('forks at the edited turn: shared prefix kept, edit runs on a NEW session, original track untouched', async () => {
    const { daemon, events, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    await daemon.sendInput({ chatId, message: 'second question', localId: 'l2' });

    const before = replay(daemon, chatId);
    const secondTurn = userMessages(before).find((m) => m.content === 'second question');
    expect(secondTurn).toBeDefined();
    const rootSessionId = metaStore.read(chatId)?.claudeSessionId;
    expect(rootSessionId).toBeTruthy();

    events.length = 0;
    await daemon.forkChat({
      chatId,
      seq: secondTurn!.seq,
      message: 'second question, rephrased',
      localId: 'l3',
    });

    // The graph is published: root + the new track, the new one active.
    const graph = lastBranches(events);
    expect(graph.branches).toHaveLength(2);
    const root = graph.branches[0]!;
    const forked = graph.branches[1]!;
    expect(root.parentBranchId).toBeNull();
    expect(root.forkFromSeq).toBeNull();
    expect(forked.parentBranchId).toBe(root.branchId);
    expect(forked.forkFromSeq).toBe(secondTurn!.seq);
    expect(graph.activeBranchId).toBe(forked.branchId);

    // The fork got its OWN Claude session — the original is not mutated.
    const meta = metaStore.read(chatId)!;
    expect(meta.claudeSessionId).toBeTruthy();
    expect(meta.claudeSessionId).not.toBe(rootSessionId);

    // The new track: shared prefix (`first question`) + the edited turn.
    // The turn it replaced is gone from THIS track.
    const after = userMessages(replay(daemon, chatId)).map((m) => m.content);
    expect(after).toContain('first question');
    expect(after).toContain('second question, rephrased');
    expect(after).not.toContain('second question');
  });

  it('switching back to the original track restores its session and transcript', async () => {
    const { daemon, events, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    await daemon.sendInput({ chatId, message: 'second question', localId: 'l2' });
    const rootSessionId = metaStore.read(chatId)!.claudeSessionId;
    const secondTurn = userMessages(replay(daemon, chatId)).find(
      (m) => m.content === 'second question',
    )!;

    await daemon.forkChat({
      chatId,
      seq: secondTurn.seq,
      message: 'second question, rephrased',
      localId: 'l3',
    });
    const rootBranchId = lastBranches(events).branches[0]!.branchId;

    events.length = 0;
    await daemon.switchBranch(chatId, rootBranchId);

    expect(lastBranches(events).activeBranchId).toBe(rootBranchId);
    expect(metaStore.read(chatId)!.claudeSessionId).toBe(rootSessionId);
    const back = userMessages(replay(daemon, chatId)).map((m) => m.content);
    expect(back).toContain('second question');
    expect(back).not.toContain('second question, rephrased');
    // Surfaces are told the chat changed underneath them.
    expect(events.some((e) => e.type === 'chat.state')).toBe(true);
  });

  it('refuses a fork with no text and no attachment, leaving the graph alone', async () => {
    const { daemon, events, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const turn = userMessages(replay(daemon, chatId))[0]!;
    const before = metaStore.read(chatId)!.branches;
    events.length = 0;
    await daemon.forkChat({ chatId, seq: turn.seq, message: '', localId: 'l2' });

    const err = events.find((e) => e.type === 'chat.error');
    expect(err).toMatchObject({ error: { code: 'fork_empty_message' } });
    expect(metaStore.read(chatId)!.branches).toEqual(before);
    expect(events.some((e) => e.type === 'chat.branches')).toBe(false);
  });

  it('the graph survives a host restart (persisted in meta.json)', async () => {
    const { daemon, events, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const turn = userMessages(replay(daemon, chatId))[0]!;
    await daemon.forkChat({ chatId, seq: turn.seq, message: 'rephrased', localId: 'l2' });
    const graph = lastBranches(events);

    const persisted = metaStore.read(chatId)!;
    expect(persisted.branches).toHaveLength(2);
    expect(persisted.activeBranchId).toBe(graph.activeBranchId);
  });

  it('a fork publishes the graph, which the server keeps and sends with history', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const turn = userMessages(replay(daemon, chatId))[0]!;
    await daemon.forkChat({ chatId, seq: turn.seq, message: 'rephrased', localId: 'l2' });

    const graph = events.filter((e): e is ChatBranchesEvent => e.type === 'chat.branches').at(-1);
    expect(graph).toBeDefined();
    expect(graph!.branches).toHaveLength(2);
  });

  it('a chat that has never been forked has a single root track', async () => {
    const { daemon, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'only question', localId: 'l1' });

    const graph = daemon.branchesEvent(chatId);
    expect(graph!.branches).toHaveLength(1);
    expect(graph!.branches[0]!.parentBranchId).toBeNull();
    expect(graph!.activeBranchId).toBe(graph!.branches[0]!.branchId);
  });
});

describe('spec/04 § Branching — forking while a turn is running', () => {
  it('the fork QUEUES behind the running turn and still forks when it runs, not before', async () => {
    const { daemon, events, folder, metaStore } = setup({ turnDelayMs: 40 });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const turn = userMessages(replay(daemon, chatId))[0]!;
    const rootSessionId = metaStore.read(chatId)!.claudeSessionId;

    // A turn is in flight when the edit lands (type-ahead, spec/04 § queueing).
    const inFlight = daemon.sendInput({ chatId, message: 'second question', localId: 'l2' });
    await daemon.forkChat({ chatId, seq: turn.seq, message: 'rephrased', localId: 'l3' });
    await inFlight;

    // The running turn finished on the ORIGINAL session; the fork then ran on
    // its own — a fork carried through the queue forks when IT runs, never
    // earlier and never on someone else's turn.
    const graph = lastBranches(events);
    expect(graph.branches).toHaveLength(2);
    expect(graph.activeBranchId).toBe(graph.branches[1]!.branchId);
    expect(metaStore.read(chatId)!.claudeSessionId).not.toBe(rootSessionId);
    const after = userMessages(replay(daemon, chatId)).map((m) => m.content);
    expect(after).toContain('rephrased');
    expect(after).not.toContain('second question');
  });
});

describe('spec/04 § Branching — NO FALLBACK on a bad fork/switch', () => {
  it('forking a seq that is not a user turn errors with fork_point_not_found and creates no branch', async () => {
    const { daemon, events, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });

    events.length = 0;
    await daemon.forkChat({ chatId, seq: 9999, message: 'nope', localId: 'l2' });

    const err = events.find((e) => e.type === 'chat.error');
    expect(err).toBeDefined();
    expect((err as { error: { code: string } }).error.code).toBe('fork_point_not_found');
    expect(branchEvents(events)).toHaveLength(0);
    expect(metaStore.read(chatId)!.branches ?? []).toHaveLength(1);
  });

  it('switching to an unknown branch errors with branch_not_found and leaves the active track alone', async () => {
    const { daemon, events, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const sessionBefore = metaStore.read(chatId)!.claudeSessionId;

    events.length = 0;
    await daemon.switchBranch(chatId, 'branch-that-does-not-exist');

    const err = events.find((e) => e.type === 'chat.error');
    expect(err).toBeDefined();
    expect((err as { error: { code: string } }).error.code).toBe('branch_not_found');
    expect(metaStore.read(chatId)!.claudeSessionId).toBe(sessionBefore);
  });
});

describe('spec/04 § Side threads — a side message extends the graph SIDEWAYS', () => {
  it('keeps the prefix up to AND INCLUDING the message, and leaves the main track intact', async () => {
    const { daemon, events, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    await daemon.sendInput({ chatId, message: 'second question', localId: 'l2' });
    const mainSessionId = metaStore.read(chatId)!.claudeSessionId;
    // The first answer: a side thread hangs off an entry the provider gave an
    // id, and a user's own message has none.
    const firstTurn = replay(daemon, chatId).find(
      (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
        e.type === 'chat.message' && e.role === 'assistant',
    )!;

    events.length = 0;
    await daemon.sideChat({
      chatId,
      seq: firstTurn.seq,
      message: 'a question on the side',
      localId: 'l3',
    });

    const graph = lastBranches(events);
    expect(graph.branches).toHaveLength(2);
    const side = graph.branches[1]!;
    expect(side.parentBranchId).toBe(graph.branches[0]!.branchId);
    expect(side.forkFromSeq).toBe(firstTurn.seq);
    expect(side.label).toMatch(/^side/);
    // spec/04 § Branching — "activeBranchId stays as the chat's main track":
    // a side branch runs independently and never becomes active, unlike an
    // edit fork. The main track's own session is therefore untouched too.
    expect(graph.activeBranchId).toBe(graph.branches[0]!.branchId);
    expect(metaStore.read(chatId)!.claudeSessionId).toBe(mainSessionId);

    // The main track (the default/active replay) is completely undisturbed —
    // the side branch's content never lands on it.
    const onMain = userMessages(replay(daemon, chatId)).map((m) => m.content);
    expect(onMain).toContain('first question');
    expect(onMain).toContain('second question');
    expect(onMain).not.toContain('a question on the side');

    // The side track: the message it hangs off is KEPT (unlike an edit, which
    // replaces it); the main track's continuation is not part of this track.
    // Requested explicitly by branchId — it is not what the chat's default
    // replay shows (spec/04 § Parallel branches: a side branch's content is
    // not broadcast into the one view a surface draws for this chat).
    const onSide = userMessages(replay(daemon, chatId, side.branchId)).map((m) => m.content);
    expect(onSide).toContain('first question');
    expect(onSide).toContain('a question on the side');
    expect(onSide).not.toContain('second question');
  });

  it('refuses a user message: it carries no provider id to fork at', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const asked = userMessages(replay(daemon, chatId))[0]!;

    events.length = 0;
    await daemon.sideChat({ chatId, seq: asked.seq, message: 'aside', localId: 'l2' });

    const err = events.find((e) => e.type === 'chat.error') as
      | { error: { code: string } }
      | undefined;
    expect(err?.error.code).toBe('fork_point_not_found');
    expect(events.some((e) => e.type === 'chat.branches')).toBe(false);
  });

  it('hangs off an ASSISTANT message too — asking about an answer is the common case', async () => {
    const { daemon, events, folder } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const answer = replay(daemon, chatId).find(
      (e): e is Extract<WireEvent, { type: 'chat.message' }> =>
        e.type === 'chat.message' && e.role === 'assistant',
    );
    expect(answer).toBeDefined();

    events.length = 0;
    await daemon.sideChat({
      chatId,
      seq: answer!.seq,
      message: 'why did you say that?',
      localId: 'l2',
    });

    const graph = lastBranches(events);
    expect(graph.branches).toHaveLength(2);
    expect(graph.branches[1]!.forkFromSeq).toBe(answer!.seq);
    const side = graph.branches[1]!;
    expect(userMessages(replay(daemon, chatId, side.branchId)).map((m) => m.content)).toContain(
      'why did you say that?',
    );
  });

  it('NO FALLBACK: a seq with no transcript entry errors and creates no branch', async () => {
    const { daemon, events, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });

    events.length = 0;
    await daemon.sideChat({ chatId, seq: 9999, message: 'nope', localId: 'l2' });

    const err = events.find((e) => e.type === 'chat.error');
    expect(err).toBeDefined();
    expect((err as { error: { code: string } }).error.code).toBe('fork_point_not_found');
    expect(branchEvents(events)).toHaveLength(0);
    expect(metaStore.read(chatId)!.branches ?? []).toHaveLength(1);
  });
});

describe('spec/04 § Branching — active track and written track never disagree', () => {
  it('a turn that would write to an inactive track fails loudly instead of writing there', async () => {
    const { daemon, events, folder, metaStore } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });

    // The phantom track a cut-off fork leaves behind: active, but no session
    // and no turn that will ever run on it.
    metaStore.update(chatId, (m) => ({
      ...m,
      branches: [
        {
          branchId: `${chatId}-b0`,
          parentBranchId: null,
          forkFromSeq: null,
          label: 'main',
          createdAt: m.updatedAt,
          sessionId: m.claudeSessionId,
        },
        {
          branchId: `${chatId}-b1`,
          parentBranchId: `${chatId}-b0`,
          forkFromSeq: 0,
          label: 'edit 1',
          createdAt: m.updatedAt,
        },
      ],
      activeBranchId: `${chatId}-b1`,
    }));

    events.length = 0;
    await daemon.sendInput({ chatId, message: 'second question', localId: 'l2' });

    const err = events.find((e) => e.type === 'chat.error') as
      | { error: { message: string } }
      | undefined;
    expect(err?.error.message).toContain('inactive track');
    expect(userMessages(replay(daemon, chatId)).map((m) => m.content)).not.toContain(
      'second question',
    );
  });
});

describe('spec/04 § Branching — the fork point comes from the record', () => {
  /** The chat's log lines, as `chatLog.ts` wrote them. */
  function logOf(home: string, chatId: string): Array<Record<string, any>> {
    return readFileSync(join(home, 'chats', chatId, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
  }

  it("an edit forks at the nativeRef of the entry before the edited turn, never reading the provider's session", async () => {
    const { daemon, sdk, events, folder, home, projectsRoot } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    await daemon.sendInput({ chatId, message: 'second question', localId: 'l2' });
    const second = userMessages(replay(daemon, chatId)).find(
      (m) => m.content === 'second question',
    )!;
    const firstAnswer = logOf(home, chatId).find(
      (r) => r.rec?.event?.type === 'chat.message' && r.rec.event.role === 'assistant',
    )!;
    expect(firstAnswer.nativeRef?.id).toEqual(expect.any(String));

    // Emptying the provider's session files changes nothing: Patch does not look.
    rmSync(projectsRoot, { recursive: true, force: true });
    mkdirSync(projectsRoot, { recursive: true });

    events.length = 0;
    await daemon.forkChat({ chatId, seq: second.seq, message: 'second, again', localId: 'l3' });
    expect(events.filter((e) => e.type === 'chat.error')).toEqual([]);
    expect(sdk.lastOptions()?.fork).toEqual({ resumeAtUuid: firstAnswer.nativeRef.id });
  });

  it('a side thread forks at the nativeRef of the entry it hangs off', async () => {
    const { daemon, sdk, folder, home } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    const answer = logOf(home, chatId).find(
      (r) => r.rec?.event?.type === 'chat.message' && r.rec.event.role === 'assistant',
    )!;
    await daemon.sideChat({ chatId, seq: answer.seq, message: 'why?', localId: 'l2' });
    expect(sdk.lastOptions()?.fork).toEqual({ resumeAtUuid: answer.nativeRef.id });
  });

  it('refuses an edit whose earlier entries were recorded before provider ids were kept', async () => {
    const { daemon, events, folder, home } = setup();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'first question', localId: 'l1' });
    await daemon.sendInput({ chatId, message: 'second question', localId: 'l2' });
    const second = userMessages(replay(daemon, chatId)).find(
      (m) => m.content === 'second question',
    )!;
    // An older chat: the same log, with no provider ids on its entries.
    const path = join(home, 'chats', chatId, 'events.jsonl');
    daemon.shutdown();
    writeFileSync(
      path,
      logOf(home, chatId)
        .map(({ nativeRef: _ref, ...r }) => JSON.stringify(r) + '\n')
        .join(''),
    );
    const reopened = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: createMockSdkBackend(),
      oauthAccessToken: 'tok',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => 1_700_000_000_000,
    });
    reopened.hydrate();
    events.length = 0;
    await reopened.forkChat({ chatId, seq: second.seq, message: 'again', localId: 'l3' });
    const err = events.find((e) => e.type === 'chat.error') as
      | { error: { code: string } }
      | undefined;
    expect(err?.error.code).toBe('fork_point_not_found');
    reopened.shutdown();
  });
});
