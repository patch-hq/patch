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
    expect(pass.description).toMatch(/Answer from the chat's agent/);
    expect(tools.map((t) => t.name)).toEqual([
      PASS_TO_AGENT_TOOL_NAME,
      'check_status',
      'look_back',
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
  const writer = () => {
    const log: string[] = [];
    let text = '';
    return {
      log,
      begin: () => ({
        append: (d: string) => {
          text += d;
        },
        finish: (heard?: string) => log.push(heard ?? text),
        text: () => text,
      }),
    };
  };

  test('is written only once its audio has played out', () => {
    vi.useFakeTimers();
    try {
      const w = writer();
      const reply = new SpokenReply(w.begin);
      reply.append('hello there');
      reply.audio(24_000); // one second
      reply.end();
      expect(w.log).toEqual([]);
      vi.advanceTimersByTime(1_001);
      expect(w.log).toEqual(['hello there']);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a cut while it plays keeps what was heard, even after the provider finished it', () => {
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
      expect(w.log).toEqual(['one two…']);
      vi.advanceTimersByTime(1_000);
      expect(w.log).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('cut before its words arrived: written as far as heard when they come', () => {
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
