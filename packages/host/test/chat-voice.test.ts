// spec/07 § Keeping voice and text as one conversation / § Call cost — the
// glue between open voice sessions and their chats, against a real chat
// host (mock SDK backend, real history log).

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createClaudeSessionProbe } from '../src/history.js';
import { createChatVoice } from '../src/audio/chatVoice.js';
import { createVoiceLedger } from '../src/audio/voiceLedger.js';
import type { VoiceSessionLike } from '../src/audio/voice-session-like.js';
import type { SessionInit } from '../src/audio/session.js';
import type { StartMessage } from '../src/audio/voiceAgent.js';
import type { ManagerChatEntry } from '../src/audio/managerVoice.js';
import { ZERO_TOKENS } from '../src/audio/voiceCost.js';

const silent = pino({ level: 'silent' });

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-chatvoice-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-chatvoice-folder-')));
  const events: WireEvent[] = [];
  let id = 0;
  let release: () => void = () => undefined;
  let turnGate: Promise<void> = Promise.resolve();
  const holdTurns = (): void => {
    turnGate = new Promise((r) => {
      release = r;
    });
  };
  // `emit` routes every wire event through the glue, as main() does.
  let observe: (e: WireEvent) => void = () => undefined;
  let drawnStarted: (chatId: string, localId: string) => void = () => undefined;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: {
      run: async function* (args: { prompt?: unknown }) {
        // A turn asked to show progress writes a message mid-turn before its final one.
        if (JSON.stringify(args.prompt ?? '').includes('with progress')) {
          yield { type: 'assistant' as const, content: 'working on it', sessionId: 'S1' };
        }
        yield { type: 'assistant' as const, content: 'agent says hi', sessionId: 'S1' };
        await turnGate;
        yield {
          type: 'result' as const,
          sessionId: 'S1',
          raw: { type: 'result', total_cost_usd: 0.2 },
        };
      },
    },
    oauthAccessToken: 'fake-token',
    emit: (e) => {
      events.push(e);
      observe(e);
    },
    logger: silent,
    now: () => Date.UTC(2026, 9, 4, 12),
    generateChatId: () => `chat-${++id}`,
    onDrawnTurnStarted: (chatId, localId) => drawnStarted(chatId, localId),
    sessionProbe: createClaudeSessionProbe({
      sessionStoreRoot: mkdtempSync(join(tmpdir(), 'patch-chatvoice-claude-')),
    }),
  });
  const open: VoiceSessionLike[] = [];
  const ledger = createVoiceLedger(join(home, 'voice-usage.jsonl'));
  const onCosted = vi.fn();
  const byId = new Map<string, VoiceSessionLike>();
  const catchUp = vi.fn(
    async (_chatId: string, earlier: StartMessage[]) => `caught up on ${earlier.length} messages`,
  );
  const retargeted: Array<[string, string]> = [];
  const listing: ManagerChatEntry[] = [];
  const glue = createChatVoice({
    daemon,
    sessionsOnChat: (chatId) => open.filter((s) => s.getCurrentChatId() === chatId),
    sessionById: (sessionId) => byId.get(sessionId),
    catchUp,
    listChats: async () => listing,
    isLocal: (chatId) => daemon.chatState.has(chatId),
    retargetCall: (sessionId, chatId) => retargeted.push([sessionId, chatId]),
    ledger,
    logger: silent,
    onCosted,
    // The host's clock, so ages read from the record and from events agree.
    now: () => Date.UTC(2026, 9, 4, 12),
  });
  observe = (e) => glue.observe(e);
  drawnStarted = (chatId, localId) => glue.handoffStarted({ chatId, handoffId: localId });
  return {
    daemon,
    events,
    folder,
    glue,
    open,
    ledger,
    onCosted,
    holdTurns,
    releaseTurns: () => release(),
    byId,
    catchUp,
    retargeted,
    listing,
  };
}

function fakeSession(chatId: string) {
  const pushed: Array<{ text: string; settled: boolean }> = [];
  let current = chatId;
  const session = {
    getCurrentChatId: () => current,
    setFocus: (id: string) => (current = id),
    pushMessage: (text: string, opts?: { handoffSettled?: boolean }) =>
      pushed.push({ text, settled: opts?.handoffSettled === true }),
  } as unknown as VoiceSessionLike;
  return { session, pushed };
}

const source = { kind: 'voice-app' as const, surfaceKind: 'desktop' as const, sessionId: 'sess-1' };

const init = (chatId: string): SessionInit => ({
  sessionId: 'sess-1',
  accountId: 'a',
  surfaceId: 's',
  surfaceKind: 'desktop',
  chatId,
  role: 'voice-call',
  surfaceHasAec: true,
});

const handoffs = (events: WireEvent[]) =>
  events.filter(
    (e): e is Extract<WireEvent, { type: 'chat.voice_handoff' }> => e.type === 'chat.voice_handoff',
  );

const messages = (events: WireEvent[]) =>
  events.filter(
    (e): e is Extract<WireEvent, { type: 'chat.message' }> => e.type === 'chat.message',
  );

describe('chat voice glue', () => {
  it('a fast voice exchange lands in the chat tagged with its surface, the reply streamed', async () => {
    const { daemon, events, folder, glue } = setup();
    const chatId = await daemon.spawnChat({ folder });
    events.length = 0;
    const tl = glue.makeTimeline(init(chatId));
    tl.userSaid(chatId, 'what is a nebula');
    const reply = tl.beginReply(chatId);
    reply.append('A cloud ');
    reply.append('of gas.');
    reply.finish();

    expect(events.filter((e) => e.type === 'chat.message_delta')).toHaveLength(2);
    expect(messages(events).map((m) => [m.role, m.content])).toEqual([
      ['user', '[voice • desktop] what is a nebula'],
      ['assistant', '[voice • desktop] A cloud of gas.'],
    ]);
  });

  it('answer permission: a plain yes or no answers the permission the chat waits on, and nothing else does', async () => {
    const { daemon, folder, glue } = setup();
    const chatId = await daemon.spawnChat({ folder });
    expect(glue.link.answerPermission(chatId, 'yes')).toBe(false);
    daemon.injectPermissionRequest(chatId, 'Bash', 'run a command');
    expect(glue.link.answerPermission(chatId, 'what does it do')).toBe(false);
    expect(daemon.getPendingPermissionForChat(chatId)).toBeDefined();
    expect(glue.link.answerPermission(chatId, 'No.')).toBe(true);
    expect(daemon.getPendingPermissionForChat(chatId)).toBeUndefined();
    daemon.injectPermissionRequest(chatId, 'Bash', 'run another');
    expect(glue.link.answerPermission(chatId, 'yes')).toBe(true);
    expect(daemon.getPendingPermissionForChat(chatId)).toBeUndefined();
  });

  it('a reply with no words is not written', async () => {
    const { daemon, events, folder, glue } = setup();
    const chatId = await daemon.spawnChat({ folder });
    events.length = 0;
    glue.makeTimeline(init(chatId)).beginReply(chatId).finish();
    expect(messages(events)).toEqual([]);
  });

  it('a write to a chat that does not exist is logged, never thrown into the provider socket', () => {
    const { glue } = setup();
    expect(() => glue.makeTimeline(init('nope')).userSaid('nope', 'hi')).not.toThrow();
  });

  it('a reply that ends a typed turn is pushed into the call; progress and the call’s own words are not', async () => {
    const { daemon, folder, glue, open } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const { session, pushed } = fakeSession(chatId);
    open.push(session);

    glue.makeTimeline(init(chatId)).userSaid(chatId, 'my own words');
    await daemon.sendInput({ chatId, message: 'typed with progress', localId: randomUUID() });

    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.text).toContain('agent says hi');
    expect(pushed[0]!.text).toMatch(/not an answer to anything you passed on/);
    expect(pushed[0]!.settled).toBe(false);
    expect(pushed.some((p) => p.text.includes('working on it'))).toBe(false);
    expect(pushed.some((p) => p.text.includes('typed with progress'))).toBe(false);
  });

  it('pass to agent: written into the chat at once, and the answer pushed to the call that asked', async () => {
    const { daemon, events, folder, glue, byId, open, holdTurns, releaseTurns } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const { session, pushed } = fakeSession(chatId);
    byId.set('sess-1', session);
    open.push(session);
    holdTurns();
    glue.link.passToAgent({ sessionId: 'sess-1', chatId, request: 'Add milk', source });
    // The request is in the chat at once, before the agent has done anything.
    expect(messages(events).map((m) => m.content)).toContain('[voice hand-off • desktop] Add milk');
    expect(pushed).toEqual([]);
    releaseTurns();
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    expect(pushed[0]).toEqual({
      text: 'Answer from the chat\'s agent to "Add milk": agent says hi',
      settled: true,
    });
    // The row records it: waiting, working, then answered with the agent's message.
    const row = messages(events).find((m) => m.content.endsWith('Add milk'))!;
    const states = handoffs(events);
    expect(states.map((h) => h.state)).toEqual(['waiting', 'working', 'answered']);
    expect(states.every((h) => h.rowSeq === row.seq && h.request === 'Add milk')).toBe(true);
    const answer = messages(events).find((m) => m.content === 'agent says hi')!;
    expect(states[2]).toMatchObject({ answer: 'agent says hi', answerSeqs: [answer.seq] });
    expect(states[2]!.from).toBeUndefined();
  });

  it('a hand-off made after the call moved here says which call it came from', async () => {
    const { daemon, events, folder, glue, byId } = setup();
    const chatA = await daemon.spawnChat({ folder });
    const chatB = await daemon.spawnChat({ folder });
    const { session } = fakeSession(chatB);
    byId.set('sess-1', session);
    glue.makeTimeline(init(chatA));
    glue.link.passToAgent({
      sessionId: 'sess-1',
      chatId: chatB,
      request: 'Water the ferns',
      source,
    });
    expect(handoffs(events)[0]!.from).toMatch(/^the call from "/);
  });

  it('check status: the hand-off and the chat agent as they stand, from the host', async () => {
    const { daemon, folder, glue, byId, holdTurns, releaseTurns } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const { session, pushed } = fakeSession(chatId);
    byId.set('sess-1', session);
    expect(glue.link.checkStatus('sess-1', chatId)).toContain(
      'Nothing has been passed to the agent on this call.',
    );
    holdTurns();
    glue.link.passToAgent({ sessionId: 'sess-1', chatId, request: 'Find the receipt', source });
    await vi.waitFor(() =>
      expect(glue.link.checkStatus('sess-1', chatId)).toContain(
        '"Find the receipt": being worked on',
      ),
    );
    const working = glue.link.checkStatus('sess-1', chatId);
    expect(working).toContain("The chat's agent now: working");
    expect(working).toContain('Its last message');
    releaseTurns();
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    const done = glue.link.checkStatus('sess-1', chatId);
    expect(done).toContain('"Find the receipt": answered');
    expect(done).toContain("The chat's agent now: idle.");
    expect(done).toMatch(/Its last message, \d+s ago: agent says hi/);
  });

  it('a hand-off that cannot run is failed loudly: pushed to the call and recorded on its row', async () => {
    const { daemon, events, folder, glue, byId } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const { session, pushed } = fakeSession(chatId);
    byId.set('sess-1', session);
    expect(() =>
      glue.link.passToAgent({ sessionId: 'sess-1', chatId: 'no-such-chat', request: 'x', source }),
    ).toThrow();
    // A chat the agent will not take: its turn fails, and the call hears it.
    const failing = vi.spyOn(daemon, 'sendInput').mockRejectedValueOnce(new Error('folder gone'));
    glue.link.passToAgent({ sessionId: 'sess-1', chatId, request: 'Tidy up', source });
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    expect(pushed[0]!.text).toContain('failed (folder gone)');
    expect(pushed[0]!.settled).toBe(true);
    expect(handoffs(events).map((h) => [h.state, h.error])).toEqual([
      ['waiting', undefined],
      ['failed', 'folder gone'],
    ]);
    failing.mockRestore();
  });

  it('an answer pushed after the call moved chat is labelled with its own chat', async () => {
    const { daemon, folder, glue, byId, holdTurns, releaseTurns } = setup();
    const chatA = await daemon.spawnChat({ folder });
    const chatB = await daemon.spawnChat({ folder });
    const { session, pushed } = fakeSession(chatA);
    byId.set('sess-1', session);
    holdTurns();
    glue.link.passToAgent({ sessionId: 'sess-1', chatId: chatA, request: 'Add milk', source });
    session.setFocus(chatB);
    releaseTurns();
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    expect(pushed[0]!.text).toMatch(/to "Add milk" \(from the chat "/);
  });

  it('switch chat: moves the call to a chat on this host, with that chat as it stands', async () => {
    const { daemon, folder, glue, listing, retargeted } = setup();
    const chatA = await daemon.spawnChat({ folder });
    const chatB = await daemon.spawnChat({ folder });
    listing.push(
      { chatId: chatA, name: 'Shopping', folder, status: 'active' },
      { chatId: chatB, name: 'Garden', folder, status: 'active' },
      { chatId: 'elsewhere', name: 'Laptop work', folder: '/x', status: 'active' },
    );
    const moved = await glue.link.switchChat('sess-1', chatA, 'garden');
    expect(moved).toMatchObject({ ok: true, chatId: chatB, name: 'Garden' });
    expect(retargeted).toEqual([['sess-1', chatB]]);
    expect(await glue.link.switchChat('sess-1', chatB, 'laptop')).toEqual({
      ok: false,
      message: '"Laptop work" is on another computer, so the call cannot move there.',
    });
    expect(await glue.link.switchChat('sess-1', chatB, 'nothing like it')).toMatchObject({
      ok: false,
    });
    expect(retargeted).toHaveLength(1);
  });

  it('start context: the last messages in full, and a catch-up written from the rest', async () => {
    const { daemon, folder, glue, catchUp } = setup();
    const chatId = await daemon.spawnChat({ folder });
    for (const m of ['one', 'two', 'three']) {
      await daemon.sendInput({ chatId, message: m, localId: randomUUID() });
    }
    const context = glue.link.startContext(chatId);
    expect(context.text).toContain('User: three');
    expect(context.text).not.toContain('User: one');
    expect(await context.catchUp).toBe('caught up on 2 messages');
    expect(catchUp.mock.calls[0]![1].map((m) => m.text)).toEqual(['one', 'agent says hi']);
  });

  it('a chat with nothing before its last messages needs no catch-up', async () => {
    const { daemon, folder, glue, catchUp } = setup();
    const chatId = await daemon.spawnChat({ folder });
    expect(glue.link.startContext(chatId).catchUp).toBeNull();
    expect(catchUp).not.toHaveBeenCalled();
  });

  it('costs a call on its voice engine alone, leaves the line in the chat, and records it', async () => {
    const { daemon, events, folder, glue, ledger, onCosted } = setup();
    const chatId = await daemon.spawnChat({ folder });
    // Agent turns on the chat are the chat's own, not a call's expense.
    await daemon.sendInput({
      chatId,
      message: 'one',
      localId: randomUUID(),
      voicePrefix: '[voice hand-off • web] ',
    });
    events.length = 0;
    glue.callEnded({
      init: init(chatId),
      chatId,
      startedAt: Date.UTC(2026, 9, 4, 12),
      endedAt: Date.UTC(2026, 9, 4, 12, 0, 52),
      engine: {
        backend: 'gemini',
        model: 'models/gemini-2.5-flash-native-audio-preview-12-2025',
        tokens: { ...ZERO_TOKENS, audioIn: 3000, textIn: 2000, audioOut: 600 },
        stt: null,
      },
    });
    expect(messages(events).map((m) => [m.role, m.content])).toEqual([
      ['system', '[call] Call 0:52 · Gemini Flash · $0.017 · 5,000 tokens in / 600 out'],
    ]);
    const t = ledger.totals(Date.UTC(2026, 9, 10));
    expect(t.monthCalls).toBe(1);
    expect(t.monthUsd).toBeCloseTo(0.0172, 6);
    expect(onCosted).toHaveBeenCalledTimes(1);
  });

  it('does not write an empty or punctuation-only utterance as the user speaking', async () => {
    const { daemon, events, folder, glue } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const tl = glue.makeTimeline(init(chatId));
    for (const blank of ['', '   ', '…', '...', ' . ', '?']) tl.userSaid(chatId, blank);
    expect(messages(events)).toEqual([]);
  });

  it('puts the line in the chat the moment the call ends, whatever the agent is doing', async () => {
    const { daemon, events, folder, glue, holdTurns, releaseTurns } = setup();
    const chatId = await daemon.spawnChat({ folder });
    holdTurns();
    const turn = daemon.sendInput({
      chatId,
      message: 'one',
      localId: randomUUID(),
      voicePrefix: '[voice hand-off • web] ',
    });
    await vi.waitFor(() => expect(messages(events).some((m) => m.role === 'assistant')).toBe(true));
    glue.callEnded({
      init: init(chatId),
      chatId,
      startedAt: Date.UTC(2026, 9, 4, 12),
      endedAt: Date.UTC(2026, 9, 4, 12, 0, 10),
      engine: { backend: 'local', model: 'local', tokens: null, stt: null },
    });
    expect(
      messages(events)
        .filter((m) => m.role === 'system')
        .map((m) => m.content),
    ).toEqual(['[call] Call 0:10 · Local · $0']);
    releaseTurns();
    await turn;
  });
});
