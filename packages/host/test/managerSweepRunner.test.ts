// spec/06 § The sweep — `ChatRunner.runManagerSweep` executes a sweep's
// decision call: answer by delivering a message (locally or cross-host) and
// noting it on the Manager thread, digest by one batched note listing the open
// questions with links to their chats, leave by doing nothing. Whether a
// question is covered by the standing instructions is the prompt's call: nothing here
// ranks or overrides what the decider returns, beyond checking the message
// reaches the chat it was written for.

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { SPECIAL_THREAD_IDS, type ManagerSweepCandidate, type WireEvent } from '@patch/wire';
import { Daemon, type HostOptions } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import type { SweepDecisionResult } from '../src/managerSweepGen.js';

const silent = pino({ level: 'silent' });

function setup(
  decideSweep: NonNullable<HostOptions['decideSweep']>,
  extra: Partial<HostOptions> = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'patch-sweep-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-sweep-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore,
    sdkBackend: sdk,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    decideSweep,
    ...extra,
  });
  return { daemon, sdk, events, folder, metaStore };
}

/** Notes are written onto the Manager thread's own log, so any test exercising
 * them needs that thread to actually exist: the first chat spawned is the Manager,
 * every later one is an ordinary chat. */
function setupWithManager(
  decideSweep: NonNullable<HostOptions['decideSweep']>,
  extra: Partial<HostOptions> = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'patch-sweep-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-sweep-folder-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(home);
  const events: WireEvent[] = [];
  const sdk = createMockSdkBackend();
  let ids = 0;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore,
    sdkBackend: sdk,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => (ids++ === 0 ? SPECIAL_THREAD_IDS.manager : `chat-${ids}`),
    decideSweep,
    ...extra,
  });
  return { daemon, sdk, events, folder, metaStore };
}

function candidate(over: Partial<ManagerSweepCandidate> = {}): ManagerSweepCandidate {
  return {
    chatId: 'chat-local',
    hostId: 'd1',
    folder: '/work/x',
    edge: 'settled',
    idleMinutes: 20,
    ...over,
  };
}

const result = (decisions: SweepDecisionResult['decisions']): SweepDecisionResult => ({
  decisions,
  tokensUsed: 42,
});

describe('runManagerSweep', () => {
  it('reports an error and touches nothing when no decider is configured', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-sweep-'));
    const metaStore = createMetaStore(home);
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore,
      sdkBackend: createMockSdkBackend(),
      oauthAccessToken: 'fake-token',
      emit: () => {},
      logger: silent,
      now: () => 1_700_000_000_000,
    });
    const out = await daemon.runManagerSweep({
      runId: 'r1',
      candidates: [candidate()],
      messagesPerChat: 3,
      prompt: 'decide',
      model: 'claude-sonnet-5',
    });
    expect(out.error).toMatch(/no decider configured/i);
    expect(out.actions).toMatchObject([]);
  });

  it('reports an error when the decision call itself fails (NO FALLBACK)', async () => {
    const { daemon } = setup(async () => null);
    const out = await daemon.runManagerSweep({
      runId: 'r1',
      candidates: [candidate()],
      messagesPerChat: 3,
      prompt: 'decide',
      model: 'claude-sonnet-5',
    });
    expect(out.error).toMatch(/decision call failed/i);
    expect(out.actions).toMatchObject([]);
  });

  const sweepReq = (
    candidates: ManagerSweepCandidate[],
    over: { prompt?: string; model?: string; messagesPerChat?: number } = {},
  ) => ({
    runId: 'r1',
    candidates,
    messagesPerChat: over.messagesPerChat ?? 1,
    prompt: over.prompt ?? 'decide',
    model: over.model ?? 'claude-sonnet-5',
  });

  const managerNotes = (events: WireEvent[]): string[] =>
    events.flatMap((e) =>
      e.type === 'chat.message' && e.chatId === SPECIAL_THREAD_IDS.manager && e.role === 'system'
        ? [e.content]
        : [],
    );

  it('answer: delivers the message into a LOCAL candidate chat as a machine turn, and shows it on the Manager thread', async () => {
    let chatId = '';
    const decide = vi.fn(async () =>
      result([{ chatId, action: 'answer', folder, message: 'carry on please' }]),
    );
    const { daemon, folder, sdk, events } = setupWithManager(decide);
    await daemon.spawnChat({ folder }); // the Manager
    sdk.enqueue([
      { type: 'assistant', content: 'ok, continuing' },
      { type: 'result', sessionId: 's1' },
    ]);
    chatId = await daemon.spawnChat({ folder });
    const out = await daemon.runManagerSweep(
      sweepReq([candidate({ chatId, hostId: 'd1', folder })]),
    );
    expect(out.actions).toMatchObject([{ chatId, action: 'answer', detail: 'carry on please' }]);
    await new Promise((r) => setTimeout(r, 20));
    const history = daemon.readHistory({ chatId });
    expect(
      history.events.some((e) => e.type === 'chat.message' && e.content === 'carry on please'),
    ).toBe(true);
    const notes = managerNotes(events);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('carry on please');
    expect(notes[0]).toContain(`patch://chats/${chatId}`);
  });

  it('answer: a chat mid-turn is left alone — the message would only queue behind the turn and go stale', async () => {
    let chatId = '';
    const decide = vi.fn(async () =>
      result([{ chatId, action: 'answer', folder, message: 'carry on please' }]),
    );
    const { daemon, folder, events } = setupWithManager(decide, {
      sdkBackend: createMockSdkBackend({ turnDelayMs: 300 }),
    });
    await daemon.spawnChat({ folder }); // the Manager
    chatId = await daemon.spawnChat({ folder });
    const running = daemon.sendInput({ chatId, message: 'long job', localId: 'u1' });
    await new Promise((r) => setTimeout(r, 30));
    expect(daemon.runningChatIds()).toContain(chatId);
    const sweep = () =>
      daemon.runManagerSweep(sweepReq([candidate({ chatId, hostId: 'd1', folder })]));
    // Two sweeps while the turn runs: neither may park a message in the queue.
    expect((await sweep()).actions).toMatchObject([{ chatId, action: 'leave' }]);
    expect((await sweep()).actions).toMatchObject([{ chatId, action: 'leave' }]);
    await running;
    await new Promise((r) => setTimeout(r, 400));
    const history = daemon.readHistory({ chatId });
    expect(
      history.events.some((e) => e.type === 'chat.message' && e.content === 'carry on please'),
    ).toBe(false);
    // Nothing was sent, so nothing is shown as sent.
    expect(managerNotes(events)).toEqual([]);
  });

  it('answer: delivers a cross-host candidate via sendToRemoteChat, never sendInput, and shows it on the Manager thread', async () => {
    const decide = vi.fn(async () =>
      result([
        {
          chatId: 'chat-remote',
          action: 'answer',
          folder: '/elsewhere',
          message: 'Yes, carry on.',
        },
      ]),
    );
    const sendToRemoteChat = vi.fn(async () => undefined);
    const { daemon, folder, events } = setupWithManager(decide, { sendToRemoteChat });
    await daemon.spawnChat({ folder }); // the Manager
    const out = await daemon.runManagerSweep(
      sweepReq([candidate({ chatId: 'chat-remote', hostId: 'd2', folder: '/elsewhere' })]),
    );
    expect(out.actions).toMatchObject([{ chatId: 'chat-remote', action: 'answer' }]);
    expect(sendToRemoteChat).toHaveBeenCalledWith({
      sourceChatId: SPECIAL_THREAD_IDS.manager,
      targetChatId: 'chat-remote',
      message: 'Yes, carry on.',
    });
    expect(managerNotes(events).join('\n')).toContain('Yes, carry on.');
  });

  it('digest: open questions from several chats are ONE note on the Manager thread, each linking to its chat', async () => {
    const decide = vi.fn(async () =>
      result([
        {
          chatId: 'chat-a',
          action: 'digest',
          question: 'Which database should this use?',
          reason: 'needs a person to decide',
        },
        {
          chatId: 'chat-b',
          action: 'digest',
          question: 'Delete the old branch?',
          reason: 'the standing instructions do not cover it',
        },
        { chatId: 'chat-c', action: 'leave' },
      ]),
    );
    const { daemon, events, folder } = setupWithManager(decide);
    await daemon.spawnChat({ folder }); // the Manager
    const out = await daemon.runManagerSweep(
      sweepReq([
        candidate({ chatId: 'chat-a', folder: '/work/a' }),
        candidate({ chatId: 'chat-b', folder: '/work/b' }),
        candidate({ chatId: 'chat-c', folder: '/work/c' }),
      ]),
    );
    expect(out.actions).toMatchObject([
      {
        chatId: 'chat-a',
        action: 'digest',
        detail: 'Which database should this use? (not answered: needs a person to decide)',
      },
      {
        chatId: 'chat-b',
        action: 'digest',
        detail: 'Delete the old branch? (not answered: the standing instructions do not cover it)',
      },
      { chatId: 'chat-c', action: 'leave' },
    ]);
    const notes = managerNotes(events);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('2 open questions');
    expect(notes[0]).toContain('(patch://chats/chat-a)');
    expect(notes[0]).toContain('Which database should this use?');
    expect(notes[0]).toContain('(patch://chats/chat-b)');
    expect(notes[0]).toContain('Delete the old branch?');
    expect(notes[0]).toContain('(not answered: needs a person to decide)');
    expect(notes[0]).toContain('(not answered: the standing instructions do not cover it)');
    expect(notes[0]).not.toContain('chat-c');
    // The same list goes out as one notification that opens the Manager thread.
    const notifies = events.filter((e) => e.type === 'notify');
    expect(notifies).toHaveLength(1);
    expect(notifies[0]).toMatchObject({ type: 'notify', chatId: SPECIAL_THREAD_IDS.manager });
    const text = (notifies[0] as { message: string }).message;
    expect(text).toContain('2 open questions');
    expect(text).toContain(
      '/work/a: Which database should this use? (not answered: needs a person to decide)',
    );
    expect(text).not.toContain('patch://');
    // a note, never a turn
    expect(events.some((e) => e.type === 'chat.input')).toBe(false);
  });

  it('digest: a question with no reason is listed as having none, not dropped or invented', async () => {
    const decide = vi.fn(async () =>
      result([{ chatId: 'chat-x', action: 'digest', question: 'Ship it?' }]),
    );
    const { daemon, events, folder } = setupWithManager(decide);
    await daemon.spawnChat({ folder });
    await daemon.runManagerSweep(sweepReq([candidate({ chatId: 'chat-x' })]));
    expect(managerNotes(events).join('\n')).toContain('Ship it? (not answered: no reason given)');
  });

  it('the reply format asks for a reason on every digest entry', async () => {
    const decide = vi.fn(async () => result([]));
    const { daemon } = setup(decide);
    await daemon.runManagerSweep(sweepReq([candidate({ chatId: 'chat-x' })]));
    const arg = decide.mock.calls[0]![0];
    expect(arg.digest).toContain('"reason"');
    expect(arg.digest).toContain('why you could not answer it');
  });

  it('digest: no open questions means no note at all', async () => {
    const decide = vi.fn(async () => result([{ chatId: 'chat-x', action: 'leave' }]));
    const { daemon, events, folder } = setupWithManager(decide);
    await daemon.spawnChat({ folder });
    await daemon.runManagerSweep(sweepReq([candidate({ chatId: 'chat-x' })]));
    expect(managerNotes(events)).toEqual([]);
    expect(events.some((e) => e.type === 'notify')).toBe(false);
  });

  it('digest: a digest entry with no question is left, not listed blank', async () => {
    const decide = vi.fn(async () => result([{ chatId: 'chat-x', action: 'digest' }]));
    const { daemon, events, folder } = setupWithManager(decide);
    await daemon.spawnChat({ folder });
    const out = await daemon.runManagerSweep(sweepReq([candidate({ chatId: 'chat-x' })]));
    expect(out.actions).toMatchObject([{ chatId: 'chat-x', action: 'leave' }]);
    expect(managerNotes(events)).toEqual([]);
  });

  it('disabled Manager: no decision call is made and nothing is delivered or noted', async () => {
    const decide = vi.fn(async () =>
      result([{ chatId: 'chat-x', action: 'answer', folder: '/work/x', message: 'go' }]),
    );
    const sendToRemoteChat = vi.fn(async () => {});
    const { daemon, events, folder } = setupWithManager(decide, { sendToRemoteChat });
    await daemon.spawnChat({ folder });
    await daemon.setDisabled(SPECIAL_THREAD_IDS.manager, true);
    events.length = 0;
    const out = await daemon.runManagerSweep(sweepReq([candidate({ chatId: 'chat-x' })]));
    expect(decide).not.toHaveBeenCalled();
    expect(out.actions).toMatchObject([{ chatId: 'chat-x', action: 'leave' }]);
    expect(sendToRemoteChat).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'chat.message')).toEqual([]);
  });

  it('disabled mid-run: a decision already in flight delivers and notes nothing', async () => {
    const sendToRemoteChat = vi.fn(async () => {});
    let disable: () => Promise<void> = async () => {};
    const decide = vi.fn(async () => {
      await disable();
      return result([
        { chatId: 'chat-remote', action: 'answer', folder: '/work/x', message: 'still there?' },
        { chatId: 'chat-x', action: 'digest', question: 'look' },
      ]);
    });
    const { daemon, events, folder } = setupWithManager(decide, { sendToRemoteChat });
    await daemon.spawnChat({ folder });
    disable = () => daemon.setDisabled(SPECIAL_THREAD_IDS.manager, true);
    events.length = 0;
    const out = await daemon.runManagerSweep(
      sweepReq([
        candidate({ chatId: 'chat-remote', hostId: 'd2' }),
        candidate({ chatId: 'chat-x' }),
      ]),
    );
    expect(out.actions).toMatchObject([
      { chatId: 'chat-remote', action: 'leave' },
      { chatId: 'chat-x', action: 'leave' },
    ]);
    expect(sendToRemoteChat).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'chat.message')).toEqual([]);
  });

  it('leave: a candidate decided "leave" does nothing observable', async () => {
    const decide = vi.fn(async () => result([{ chatId: 'chat-x', action: 'leave' }]));
    const { daemon, events } = setup(decide);
    const out = await daemon.runManagerSweep(sweepReq([candidate({ chatId: 'chat-x' })]));
    expect(out.actions).toMatchObject([{ chatId: 'chat-x', action: 'leave' }]);
    expect(events).toEqual([]);
  });

  it('there are no judgement rules in code: a chat the decider never addressed is left alone, whatever it was', async () => {
    const decide = vi.fn(async () => result([]));
    const { daemon, events } = setup(decide);
    const out = await daemon.runManagerSweep(sweepReq([candidate({ chatId: 'chat-x' })]));
    expect(out.actions).toMatchObject([{ chatId: 'chat-x', action: 'leave' }]);
    expect(events).toEqual([]);
  });

  it('passes the standing instructions + model through, and the digest carries only facts and the reply format', async () => {
    const decide = vi.fn(async () => result([]));
    const { daemon } = setup(decide);
    await daemon.runManagerSweep(
      sweepReq([candidate({ chatId: 'chat-x', idleMinutes: 17 })], {
        prompt: 'MY STANDING INSTRUCTIONS',
        model: 'claude-haiku-4-5-20251001',
      }),
    );
    expect(decide).toHaveBeenCalledTimes(1);
    const arg = decide.mock.calls[0]![0];
    expect(arg.prompt).toBe('MY STANDING INSTRUCTIONS');
    expect(arg.model).toBe('claude-haiku-4-5-20251001');
    expect(arg.digest).toContain('chat-x');
    expect(arg.digest).toContain('went idle');
    expect(arg.digest).toContain('answer|digest|leave');
    expect(arg.digest).not.toMatch(/stalled|permission|nudge|wake|flag/);
  });

  it('reports the tokensUsed from the decision call', async () => {
    const decide = vi.fn(async () => ({ decisions: [], tokensUsed: 777 }));
    const { daemon } = setup(decide);
    const out = await daemon.runManagerSweep(sweepReq([candidate({ chatId: 'chat-x' })]));
    expect(out.tokensUsed).toBe(777);
  });

  it('a reply naming a different folder than the chat it targets is not delivered', async () => {
    let chatId = '';
    const decide = vi.fn(async () =>
      result([{ chatId, action: 'answer', folder: '/some/other/project', message: 'wrong chat' }]),
    );
    const { daemon, folder } = setup(decide);
    chatId = await daemon.spawnChat({ folder });
    const out = await daemon.runManagerSweep(
      sweepReq([candidate({ chatId, hostId: 'd1', folder })]),
    );
    expect(out.actions).toMatchObject([
      { chatId, action: 'leave', detail: expect.stringMatching(/not sent/) },
    ]);
    const history = daemon.readHistory({ chatId });
    expect(
      history.events.some((e) => e.type === 'chat.message' && e.content === 'wrong chat'),
    ).toBe(false);
  });

  it('an answer reply with no folder is not delivered (no fallback)', async () => {
    const decide = vi.fn(async () =>
      result([{ chatId: 'chat-remote', action: 'answer', message: 'hi' }]),
    );
    const sendToRemoteChat = vi.fn(async () => undefined);
    const { daemon } = setup(decide, { sendToRemoteChat });
    const out = await daemon.runManagerSweep(
      sweepReq([candidate({ chatId: 'chat-remote', hostId: 'd2', folder: '/elsewhere' })]),
    );
    expect(out.actions).toMatchObject([{ action: 'leave' }]);
    expect(sendToRemoteChat).not.toHaveBeenCalled();
  });

  it('an answer with no message is not delivered', async () => {
    const decide = vi.fn(async () =>
      result([{ chatId: 'chat-remote', action: 'answer', folder: '/elsewhere' }]),
    );
    const sendToRemoteChat = vi.fn(async () => undefined);
    const { daemon } = setup(decide, { sendToRemoteChat });
    const out = await daemon.runManagerSweep(
      sweepReq([candidate({ chatId: 'chat-remote', hostId: 'd2', folder: '/elsewhere' })]),
    );
    expect(out.actions).toMatchObject([{ action: 'leave' }]);
    expect(sendToRemoteChat).not.toHaveBeenCalled();
  });

  it('records what was sent and why, so the UI can show it', async () => {
    const decide = vi.fn(async () =>
      result([{ chatId: 'chat-remote', action: 'answer', folder: '/elsewhere', message: 'go on' }]),
    );
    const { daemon, folder } = setupWithManager(decide, {
      sendToRemoteChat: vi.fn(async () => undefined),
    });
    await daemon.spawnChat({ folder });
    const out = await daemon.runManagerSweep(
      sweepReq([candidate({ chatId: 'chat-remote', hostId: 'd2', folder: '/elsewhere' })]),
    );
    expect(out.actions).toEqual([
      { chatId: 'chat-remote', action: 'answer', edge: 'settled', detail: 'go on' },
    ]);
  });

  it('cancelManagerSweep mid-decision: nothing is delivered', async () => {
    const sendToRemoteChat = vi.fn(async () => undefined);
    let cancel: () => void = () => {};
    const decide = vi.fn(async () => {
      cancel();
      return result([
        { chatId: 'chat-remote', action: 'answer', folder: '/elsewhere', message: 'late' },
      ]);
    });
    const { daemon } = setup(decide, { sendToRemoteChat });
    cancel = () => daemon.cancelManagerSweep();
    const out = await daemon.runManagerSweep(
      sweepReq([candidate({ chatId: 'chat-remote', hostId: 'd2', folder: '/elsewhere' })]),
    );
    expect(out.actions).toMatchObject([{ action: 'leave' }]);
    expect(sendToRemoteChat).not.toHaveBeenCalled();
  });
});
