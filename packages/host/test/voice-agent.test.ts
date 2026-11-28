// spec/07 § The voice agent and the chat's agent / § Voice instructions /
// § Keeping voice and text as one conversation / § Barge-in — the parts of a
// voice agent call that are the same on every provider.

import { describe, test, expect, vi } from 'vitest';
import pino from 'pino';
import { DEFAULT_VOICE_INSTRUCTIONS } from '@patch/wire';
import type { AudioEvent } from '@patch/wire/audio';
import {
  heardPart,
  startContextText,
  voiceAgentInstructions,
  voiceAgentTools,
  PASS_TO_AGENT_TOOL_NAME,
  SEND_TO_CHAT_TOOL_NAME,
  type StartFacts,
} from '../src/audio/voiceAgent.js';
import {
  GOODBYE_MAX_MS,
  VoiceAgentCall,
  type VoiceAgentEngine,
} from '../src/audio/voiceAgentCall.js';
import { SpokenReply } from '../src/audio/spokenReply.js';
import { fakeVoiceAgentLink } from './helpers/fakeVoiceAgentLink.js';

const logger = pino({ level: 'silent' });

describe('voice instructions', () => {
  test('the default says what the voice is and gives no tone directions', () => {
    expect(DEFAULT_VOICE_INSTRUCTIONS).toMatch(/voice of this chat/);
    expect(DEFAULT_VOICE_INSTRUCTIONS).toMatch(/not an assistant meeting them for the first time/);
    expect(DEFAULT_VOICE_INSTRUCTIONS).not.toMatch(/warm|concise|friendly|cheerful|tone/i);
  });

  test('instructions, then extra user text, then tone, then start context — nothing else', () => {
    expect(
      voiceAgentInstructions({
        instructions: 'Mine.',
        extra: ['Spoken aloud.'],
        tone: 'Calm.',
        startContext: 'CHAT',
      }),
    ).toBe('Mine.\n\nSpoken aloud.\n\nCalm.\n\nCHAT');
    expect(voiceAgentInstructions({ instructions: 'Mine.', tone: '  ' })).toBe('Mine.');
  });

  test('everything about a tool is in its description', () => {
    const tools = voiceAgentTools({ handoff: 'auto', lookBack: true, switchChat: true });
    const pass = tools.find((t) => t.name === PASS_TO_AGENT_TOOL_NAME)!;
    expect(pass.description).toMatch(/answers "received" at once/);
    expect(pass.description).toMatch(/relay it as that message instructs/);
    expect(tools.map((t) => t.name)).toEqual([
      PASS_TO_AGENT_TOOL_NAME,
      'check_status',
      'look_back',
      'find_chats',
      'chat_status',
      'send_to_chat',
      'end_call',
      'switch_chat',
    ]);
  });
});

describe('start context', () => {
  const at = Date.UTC(2026, 10, 27, 14, 5);
  const facts: StartFacts = {
    name: 'Train times',
    goal: 'Get to Leeds by noon',
    openQuestions: ['Which day?'],
    recent: [
      { role: 'user', text: 'when is my train', at },
      { role: 'assistant', text: 'the 09:14', at: at + 60_000 },
    ],
    earlier: [{ role: 'user', text: 'plan a trip', at: at - 3_600_000 }],
  };

  test('name, goal, open questions, the last messages with their times, and look back', () => {
    const text = startContextText(facts, at + 120_000);
    expect(text).toContain('Chat: Train times');
    expect(text).toContain('Goal: Get to Leeds by noon');
    expect(text).toContain('Questions to the user still open:\n- Which day?');
    expect(text).toMatch(/\] User: when is my train\n\[.*\] Agent: the 09:14/);
    expect(text).toContain('catch-up');
    expect(text).toContain('look_back');
    // The earlier messages go to the catch-up, not in full here.
    expect(text).not.toContain('plan a trip');
  });

  test('a giant message is cut, and says where to find the rest', () => {
    const big = startContextText(
      { ...facts, recent: [{ role: 'assistant', text: 'x'.repeat(20_000), at }], earlier: [] },
      at,
    );
    expect(big.length).toBeLessThan(10_000);
    expect(big).toContain('(cut; look_back for more)');
  });
});

describe('heardPart', () => {
  test('cuts at a word boundary in proportion to what played', () => {
    expect(heardPart('one two three four', 500, 1000)).toBe('one two…');
    expect(heardPart('one two three four', 1000, 1000)).toBe('one two three four');
    expect(heardPart('one two', 0, 1000)).toBe('');
  });
});

describe('SpokenReply', () => {
  /** What the chat's one message for the reply says after each change. */
  const writer = () => {
    const log: string[] = [];
    let begun = 0;
    return {
      log,
      begins: () => begun,
      begin: () => {
        begun += 1;
        return {
          set: (t: string) => log.push(t),
          finish: () => {},
        };
      },
    };
  };

  test('is one message from its first word, changed in place as more words arrive', () => {
    const w = writer();
    const reply = new SpokenReply(w.begin);
    reply.append('hello');
    reply.append(' there\n\nsecond paragraph');
    reply.end();
    expect(w.begins()).toBe(1);
    expect(w.log).toEqual(['hello', 'hello there\n\nsecond paragraph']);
  });

  test('a cut while it plays cuts the same message to what was heard, even after the provider finished it', () => {
    vi.useFakeTimers();
    try {
      const w = writer();
      const reply = new SpokenReply(w.begin);
      reply.append('one two three four');
      reply.audio(24_000);
      reply.end();
      vi.advanceTimersByTime(500);
      expect(reply.playing()).toBe(true);
      expect(reply.cut()).toBe(500);
      expect(w.begins()).toBe(1);
      expect(w.log.at(-1)).toBe('one two…');
      vi.advanceTimersByTime(1_000);
      expect(w.log.at(-1)).toBe('one two…');
    } finally {
      vi.useRealTimers();
    }
  });

  test("a provider's account of what was heard is the text, marked as cut", () => {
    const w = writer();
    const reply = new SpokenReply(w.begin);
    reply.append('one two three four');
    reply.audio(24_000);
    expect(reply.stop()).not.toBeNull();
    reply.cutAs('one two three');
    expect(w.log.at(-1)).toBe('one two three…');
    reply.append(' more');
    expect(w.log.at(-1)).toBe('one two three…');
  });

  test('cut before its words arrived: cut as far as heard when they come', () => {
    vi.useFakeTimers();
    try {
      const w = writer();
      const reply = new SpokenReply(w.begin);
      reply.audio(24_000);
      vi.advanceTimersByTime(500);
      reply.cut();
      expect(w.log).toEqual([]);
      reply.append('one two three four');
      expect(w.log).toEqual(['one two…']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('VoiceAgentCall', () => {
  function makeCall(link = fakeVoiceAgentLink().link, callReason?: string) {
    const events: AudioEvent[] = [];
    const call = new VoiceAgentCall({
      ...(callReason !== undefined ? { callReason } : {}),
      link,
      sessionId: 's1',
      chatId: 'chat-1',
      source: { kind: 'voice-app', surfaceKind: 'web', sessionId: 's1' },
      logger,
      sendAudio: (e) => events.push(e),
    });
    let idle = true;
    const spoken: string[] = [];
    const context: string[] = [];
    const engine: VoiceAgentEngine = {
      addContext: (t) => context.push(t),
      speakAbout: (t) => spoken.push(t),
      isIdle: () => idle,
      playbackLeftMs: () => 0,
    };
    return { call, events, engine, spoken, context, setIdle: (v: boolean) => (idle = v) };
  }

  test("an agent's call: its reason ends the start context, and the voice opens with it first", () => {
    const { call, engine, spoken } = makeCall(undefined, 'The deploy failed; roll back?');
    expect(call.startContext()).toMatch(
      /The chat's agent called the user: The deploy failed; roll back\?$/,
    );
    call.push('an answer that landed meanwhile');
    call.attach(engine);
    expect(spoken[0]).toMatch(/^The chat's agent called the user and they have just answered/);
    expect(spoken[0]).toContain('The deploy failed; roll back?');
  });

  test('pushes wait for a quiet line and go out one at a time, in order', () => {
    const { call, engine, spoken, setIdle } = makeCall();
    call.push('first');
    call.attach(engine);
    expect(spoken).toEqual(['first']);
    setIdle(false);
    call.push('second');
    call.push('third');
    expect(spoken).toEqual(['first']);
    setIdle(true);
    call.flush();
    expect(spoken).toEqual(['first', 'second']);
    call.flush();
    expect(spoken).toEqual(['first', 'second', 'third']);
  });

  test('a hand-off stays open until its answer has been spoken', async () => {
    const { call, engine, setIdle, events } = makeCall();
    call.attach(engine);
    expect(await call.runTool(PASS_TO_AGENT_TOOL_NAME, { request: 'x' })).toBe('received');
    // The device is told, so it plays the passed to agent sound.
    expect(events).toContainEqual({ type: 'audio.passed_to_agent', sessionId: 's1' });
    expect(call.openHandoffs()).toBe(1);
    setIdle(false);
    call.push('answer', { handoffSettled: true });
    expect(call.openHandoffs()).toBe(1);
    setIdle(true);
    call.flush();
    expect(call.openHandoffs()).toBe(0);
  });

  test('send_to_chat answers received at once; the chat’s reply is pushed once, labelled with its name', async () => {
    let reply!: (text: string) => void;
    const { link } = fakeVoiceAgentLink({
      sendToChat: async () => ({
        ok: true,
        name: 'Laptop build',
        reply: new Promise<string>((r) => (reply = r)),
      }),
    });
    const { call, engine, spoken, events } = makeCall(link);
    call.attach(engine);
    expect(
      await call.runTool(SEND_TO_CHAT_TOOL_NAME, { chat: 'laptop', message: 'run tests' }),
    ).toBe('received');
    expect(events).toContainEqual({ type: 'audio.passed_to_agent', sessionId: 's1' });
    expect(call.openHandoffs()).toBe(1);
    expect(spoken).toEqual([]);
    reply('All 212 tests pass.');
    await vi.waitFor(() => expect(spoken).toHaveLength(1));
    expect(spoken[0]).toContain('Chat: Laptop build');
    expect(spoken[0]).toContain('run tests');
    expect(spoken[0]).toContain('All 212 tests pass.');
    expect(call.openHandoffs()).toBe(0);
    call.flush();
    expect(spoken).toHaveLength(1);
  });

  test('a reply with no answer in it is a receipt: nothing is pushed and the send closes', async () => {
    const { link } = fakeVoiceAgentLink({
      sendToChat: async () => ({ ok: true, name: 'Laptop build', reply: Promise.resolve('  ') }),
    });
    const { call, engine, spoken } = makeCall(link);
    call.attach(engine);
    await call.runTool(SEND_TO_CHAT_TOOL_NAME, { chat: 'laptop', message: 'x' });
    await vi.waitFor(() => expect(call.openHandoffs()).toBe(0));
    expect(spoken).toEqual([]);
  });

  test('a chat that fails to answer is pushed as a failure, never as an answer', async () => {
    const { link } = fakeVoiceAgentLink({
      sendToChat: async () => ({
        ok: true,
        name: 'Laptop build',
        reply: Promise.reject(new Error('rate limited')),
      }),
    });
    const { call, engine, spoken } = makeCall(link);
    call.attach(engine);
    await call.runTool(SEND_TO_CHAT_TOOL_NAME, { chat: 'laptop', message: 'x' });
    await vi.waitFor(() => expect(spoken).toHaveLength(1));
    expect(spoken[0]).toContain('It failed:');
    expect(spoken[0]).toContain('rate limited');
  });

  test('a name that is not one chat comes back to the voice and opens nothing', async () => {
    const { link } = fakeVoiceAgentLink({
      sendToChat: async () => ({ ok: false, message: 'Several chats match "bus".' }),
    });
    const { call, events } = makeCall(link);
    expect(await call.runTool(SEND_TO_CHAT_TOOL_NAME, { chat: 'bus', message: 'x' })).toBe(
      'Several chats match "bus".',
    );
    expect(call.openHandoffs()).toBe(0);
    expect(events).toEqual([]);
  });

  test('a message that was not delivered is an error on the call', async () => {
    const { link } = fakeVoiceAgentLink({
      sendToChat: async () => {
        throw new Error('host offline');
      },
    });
    const { call, events } = makeCall(link);
    expect(await call.runTool(SEND_TO_CHAT_TOOL_NAME, { chat: 'laptop', message: 'x' })).toMatch(
      /host offline/,
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'audio.error', code: 'voice_tool_failed' }),
    );
    expect(call.openHandoffs()).toBe(0);
  });

  test('a catch-up written before the session is up is added once it is', async () => {
    const { link } = fakeVoiceAgentLink({
      startContext: () => ({ text: 'CTX', catchUp: Promise.resolve('caught up') }),
    });
    const { call, engine, context } = makeCall(link);
    expect(call.startContext()).toBe('CTX');
    await Promise.resolve();
    await Promise.resolve();
    expect(context).toEqual([]);
    call.attach(engine);
    expect(context).toHaveLength(1);
    expect(context[0]).toContain('caught up');
  });

  test('end call waits for the reply to end, which the engine signals by flushing', async () => {
    const { link } = fakeVoiceAgentLink();
    const { call, engine, setIdle } = makeCall(link);
    call.attach(engine);
    setIdle(false);
    const ending = call.runTool('end_call', {});
    await new Promise((r) => setTimeout(r, 50));
    expect(link.endCall).not.toHaveBeenCalled();
    setIdle(true);
    call.flush();
    await expect(ending).resolves.toBe('The call has ended.');
    expect(link.endCall).toHaveBeenCalledWith('s1');
  });

  test('a goodbye that never ends is bounded: the call ends anyway', async () => {
    vi.useFakeTimers();
    try {
      const { link } = fakeVoiceAgentLink();
      const { call, engine, setIdle } = makeCall(link);
      call.attach(engine);
      setIdle(false);
      const ending = call.runTool('end_call', {});
      await vi.advanceTimersByTimeAsync(GOODBYE_MAX_MS - 1);
      expect(link.endCall).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(ending).resolves.toBe('The call has ended.');
    } finally {
      vi.useRealTimers();
    }
  });

  test('end call waits for the goodbye to have played, then hangs up through the host', async () => {
    const { link } = fakeVoiceAgentLink();
    const { call, engine } = makeCall(link);
    let left = 250;
    call.attach({ ...engine, playbackLeftMs: () => left });
    const ending = call.runTool('end_call', {});
    await new Promise((r) => setTimeout(r, 120));
    expect(link.endCall).not.toHaveBeenCalled();
    left = 0;
    await expect(ending).resolves.toBe('The call has ended.');
    expect(link.endCall).toHaveBeenCalledWith('s1');
  });

  test('switch chat moves the call and answers with the new chat as it stands', async () => {
    const { link } = fakeVoiceAgentLink({
      switchChat: async () => ({
        ok: true,
        chatId: 'chat-2',
        name: 'Garden',
        context: { text: 'Chat: Garden', catchUp: null },
      }),
    });
    const { call } = makeCall(link);
    const answer = await call.runTool('switch_chat', { chat: 'garden' });
    expect(call.chatId).toBe('chat-2');
    expect(answer).toContain('The call is now on the chat "Garden"');
    expect(answer).toContain('Chat: Garden');
  });
});
