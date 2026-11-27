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
import { ZERO_TOKENS } from '../src/audio/voiceCost.js';

const silent = pino({ level: 'silent' });

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'patch-chatvoice-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-chatvoice-folder-')));
  const events: WireEvent[] = [];
  let id = 0;
  // The glue's clock, moved by `advance` so a hand-off's times can be read.
  let clock = Date.UTC(2026, 9, 4, 12);
  let release: () => void = () => undefined;
  let turnGate: Promise<void> = Promise.resolve();
  const holdTurns = (): void => {
    turnGate = new Promise((r) => {
      release = r;
    });
  };
  // `emit` routes every wire event through the glue, as main() does.
  let observe: (e: WireEvent) => void = () => undefined;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: {
      run: async function* () {
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
    sessionProbe: createClaudeSessionProbe({
      sessionStoreRoot: mkdtempSync(join(tmpdir(), 'patch-chatvoice-claude-')),
    }),
  });
  const open: VoiceSessionLike[] = [];
  const ledger = createVoiceLedger(join(home, 'voice-usage.jsonl'));
  const onCosted = vi.fn();
  const glue = createChatVoice({
    daemon,
    sessionsOnChat: (chatId) => open.filter((s) => s.getCurrentChatId() === chatId),
    ledger,
    logger: silent,
    onCosted,
    now: () => clock,
  });
  observe = (e) => glue.observe(e);
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
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function fakeSession(chatId: string, awaitingHandoff = false) {
  const pushed: Array<[string, string]> = [];
  const session = {
    getCurrentChatId: () => chatId,
    isAwaitingHandoff: () => awaitingHandoff,
    pushContext: (role: string, text: string) => pushed.push([role, text]),
  } as unknown as VoiceSessionLike;
  return { session, pushed };
}

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

  it("anything landing in the chat from elsewhere goes into the open call's context — but not the call's own words", async () => {
    const { daemon, folder, glue, open } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const { session, pushed } = fakeSession(chatId);
    open.push(session);

    glue.makeTimeline(init(chatId)).userSaid(chatId, 'my own words');
    await daemon.sendInput({ chatId, message: 'typed elsewhere', localId: randomUUID() });

    expect(pushed).toEqual([
      ['user', 'typed elsewhere'],
      ['assistant', 'agent says hi'],
    ]);
  });

  it("a hand-off's request and its answer are not pushed back as news", async () => {
    const { daemon, folder, open } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const { session, pushed } = fakeSession(chatId, true);
    open.push(session);
    await daemon.sendInput({
      chatId,
      message: 'Add milk',
      voicePrefix: '[voice hand-off • desktop] ',
      localId: randomUUID(),
    });
    expect(pushed).toEqual([]);
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

  it('counts a hand-off in the call line without writing it twice (the chat already holds the request and the answer)', async () => {
    const { daemon, events, folder, glue } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const sessionId = init(chatId).sessionId;
    glue.handoffSent({ sessionId, chatId, handoffId: 'h1', rowSeq: 0, request: 'Add milk' });
    glue.handoffAnswered({ chatId, handoffId: 'h1', reply: { text: 'Done.', seqs: [2] } });
    glue.callEnded({
      init: init(chatId),
      chatId,
      startedAt: Date.UTC(2026, 9, 4, 12),
      endedAt: Date.UTC(2026, 9, 4, 12, 0, 52),
      engine: {
        backend: 'gemini',
        model: 'models/gemini-2.5-flash-native-audio-preview-12-2025',
        tokens: null,
        stt: null,
      },
    });
    expect(
      messages(events)
        .filter((m) => m.role === 'system')
        .map((m) => m.content),
    ).toEqual(['[call] Call 0:52 · Gemini Flash · $0']);
  });

  it("records a hand-off as waiting, working, then answered with the agent's messages", async () => {
    const { daemon, events, folder, glue, advance } = setup();
    const chatId = await daemon.spawnChat({ folder });
    const sent = Date.UTC(2026, 9, 4, 12);
    glue.handoffSent({ sessionId: 's', chatId, handoffId: 'h1', rowSeq: 3, request: 'Add milk' });
    advance(4_000);
    glue.handoffStarted({ chatId, handoffId: 'h1' });
    // Taken once: a second start (a re-armed waiter) does not move it.
    glue.handoffStarted({ chatId, handoffId: 'h1' });
    advance(34_000);
    glue.handoffAnswered({ chatId, handoffId: 'h1', reply: { text: 'Added.', seqs: [5, 7] } });
    const states = handoffs(events);
    expect(states.map((h) => h.state)).toEqual(['waiting', 'working', 'answered']);
    expect(states.every((h) => h.handoffId === 'h1' && h.rowSeq === 3)).toBe(true);
    expect(states[2]).toMatchObject({
      request: 'Add milk',
      sentAt: sent,
      startedAt: sent + 4_000,
      endedAt: sent + 38_000,
      answer: 'Added.',
      answerSeqs: [5, 7],
    });
    // Each record has its own place in the chat's numbering.
    expect(new Set(states.map((h) => h.seq)).size).toBe(3);
    // Nothing is written as a message: the row is the hand-off's own line.
    expect(messages(events)).toEqual([]);
  });

  it('records a failed hand-off on its row, so a pending one never hangs', async () => {
    const { daemon, events, folder, glue } = setup();
    const chatId = await daemon.spawnChat({ folder });
    glue.handoffSent({ sessionId: 's', chatId, handoffId: 'h1', rowSeq: 0, request: 'Add milk' });
    glue.handoffAnswered({ chatId, handoffId: 'h1', error: 'boom' });
    expect(handoffs(events).map((h) => [h.state, h.error])).toEqual([
      ['waiting', undefined],
      ['failed', 'boom'],
    ]);
    // Settled: a late answer for it changes nothing.
    glue.handoffAnswered({ chatId, handoffId: 'h1', reply: { text: 'late', seqs: [] } });
    expect(handoffs(events)).toHaveLength(2);
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
