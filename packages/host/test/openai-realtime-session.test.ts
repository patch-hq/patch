// OpenAI Realtime session unit tests. The provider socket is an in-memory fake
// — OpenAI Realtime is a paid API and nothing here may reach it.

import { describe, test, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import {
  OpenAIRealtimeSession,
  upsample16kTo24k,
  type OpenAIRealtimeDeps,
  type OpenAIWsCtor,
} from '../src/audio/openai-realtime.js';
import { DEFAULT_VOICE_INSTRUCTIONS } from '@patch/wire';
import { PASS_TO_AGENT_TOOL_NAME } from '../src/audio/voiceAgent.js';
import { fakeVoiceAgentLink, FAKE_START_CONTEXT } from './helpers/fakeVoiceAgentLink.js';
import type { SessionInit } from '../src/audio/session.js';
import type { AudioEvent } from '@patch/wire/audio';
import { FakeTimeline } from './gemini-live-session.test.js';
import type { VoiceProfile } from '@patch/wire';
import { RecentVoices } from '../src/audio/speakerId.js';

const logger = pino({ level: 'silent' });

class FakeOpenAIWs extends EventEmitter {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  constructor(
    public readonly url: string,
    public readonly opts: { headers: Record<string, string> },
  ) {
    super();
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
  }
  serverSend(ev: unknown): void {
    this.emit('message', JSON.stringify(ev));
  }
  ofType(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m['type'] === type);
  }
}

function makeInit(overrides: Partial<SessionInit> = {}): SessionInit {
  return {
    sessionId: 'sess-1',
    accountId: 'acct-1',
    surfaceId: 'surf-1',
    surfaceKind: 'mobile',
    chatId: 'chat-1',
    role: 'voice-call',
    surfaceHasAec: true,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<OpenAIRealtimeDeps> = {}): {
  deps: OpenAIRealtimeDeps;
  events: AudioEvent[];
  binary: Int16Array[];
  last: { ws?: FakeOpenAIWs };
  passed: ReturnType<typeof fakeVoiceAgentLink>['passed'];
  link: ReturnType<typeof fakeVoiceAgentLink>['link'];
  onFatal: ReturnType<typeof vi.fn>;
  timeline: FakeTimeline;
} {
  const events: AudioEvent[] = [];
  const binary: Int16Array[] = [];
  const last: { ws?: FakeOpenAIWs } = {};
  const { link, passed } = fakeVoiceAgentLink();
  const onFatal = vi.fn();
  const timeline = new FakeTimeline();
  const wsCtor = function (this: unknown, url: string, opts: { headers: Record<string, string> }) {
    last.ws = new FakeOpenAIWs(url, opts);
    return last.ws;
  } as unknown as OpenAIWsCtor;
  const deps: OpenAIRealtimeDeps = {
    logger,
    sendAudio: (ev) => events.push(ev),
    sendBinary: (pcm) => binary.push(pcm),
    link,
    instructions: DEFAULT_VOICE_INSTRUCTIONS,
    apiKey: 'o-key',
    model: 'gpt-realtime-2.1-mini',
    wsCtor,
    onFatal,
    timeline,
    ...overrides,
  };
  return { deps, events, binary, last, passed, link, onFatal, timeline };
}

async function open(
  session: OpenAIRealtimeSession,
  last: { ws?: FakeOpenAIWs },
): Promise<FakeOpenAIWs> {
  session.onSessionStart();
  await vi.waitFor(() => expect(last.ws).toBeDefined());
  const ws = last.ws!;
  ws.emit('open');
  await vi.waitFor(() => expect(ws.ofType('session.update')).toHaveLength(1));
  ws.serverSend({ type: 'session.updated' });
  await vi.waitFor(() => expect(session.getState()).toBe('listening'));
  return ws;
}

function audioDelta(samples: number): { type: string; delta: string } {
  const pcm = new Int16Array(samples).fill(1000);
  return { type: 'response.output_audio.delta', delta: Buffer.from(pcm.buffer).toString('base64') };
}

describe('the opening line', () => {
  test("a call answering an agent's ring opens with its reason: an item, then a response", async () => {
    const { deps, last } = makeDeps();
    const session = new OpenAIRealtimeSession(
      makeInit({ callReason: 'The deploy failed; shall I roll back?' }),
      deps,
    );
    const ws = await open(session, last);
    const items = ws.ofType('conversation.item.create') as Array<{
      item: { content: Array<{ text: string }> };
    }>;
    expect(items.at(-1)!.item.content[0]!.text).toContain('The deploy failed; shall I roll back?');
    expect(ws.ofType('response.create')).toHaveLength(1);
    await session.close();
  });

  test('a call the user placed asks for no response until they speak', async () => {
    const { deps, last } = makeDeps();
    const session = new OpenAIRealtimeSession(makeInit(), deps);
    const ws = await open(session, last);
    expect(ws.ofType('response.create')).toHaveLength(0);
    await session.close();
  });
});

describe('upsample16kTo24k', () => {
  test('3 output samples per 2 input, endpoints preserved, midpoints interpolated', () => {
    const out = upsample16kTo24k(Int16Array.from([0, 300, 600, 900]));
    expect(out.length).toBe(6);
    expect(Array.from(out)).toEqual([0, 200, 400, 600, 800, 900]);
  });
  test('empty frame → empty frame', () => {
    expect(upsample16kTo24k(new Int16Array(0)).length).toBe(0);
  });
});

describe('OpenAIRealtimeSession', () => {
  test('connects with a bearer key to the model URL and configures a 24 kHz audio session with the voice agent tools', async () => {
    const { deps, last, events } = makeDeps();
    const session = new OpenAIRealtimeSession(makeInit(), deps);
    const ws = await open(session, last);
    expect(ws.url).toBe('wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1-mini');
    expect(ws.opts.headers['Authorization']).toBe('Bearer o-key');
    const update = ws.ofType('session.update')[0] as {
      session: {
        type: string;
        audio: {
          input: { format: { rate: number }; turn_detection: { create_response: boolean } };
          output: { format: { rate: number } };
        };
        tools: Array<{ name: string }>;
      };
    };
    expect(update.session.type).toBe('realtime');
    expect(update.session.audio.input.format.rate).toBe(24000);
    expect(update.session.audio.output.format.rate).toBe(24000);
    expect(update.session.audio.input.turn_detection.create_response).toBe(true);
    expect(update.session.tools.map((t) => t.name)).toEqual([
      PASS_TO_AGENT_TOOL_NAME,
      'check_status',
      'look_back',
      'find_chats',
      'chat_status',
      'end_call',
      'switch_chat',
    ]);
    expect(events).toContainEqual({ type: 'audio.state', sessionId: 'sess-1', state: 'listening' });
  });

  test('mic frames queued before setup are flushed afterwards, upsampled to 24 kHz', async () => {
    const { deps, last } = makeDeps();
    const session = new OpenAIRealtimeSession(makeInit(), deps);
    session.onSessionStart();
    await vi.waitFor(() => expect(last.ws).toBeDefined());
    await session.onMicFrame(new Int16Array(640));
    const ws = last.ws!;
    ws.emit('open');
    await vi.waitFor(() => expect(ws.ofType('session.update')).toHaveLength(1));
    expect(ws.ofType('input_audio_buffer.append')).toHaveLength(0);
    ws.serverSend({ type: 'session.updated' });
    await vi.waitFor(() => expect(ws.ofType('input_audio_buffer.append')).toHaveLength(1));
    const b64 = ws.ofType('input_audio_buffer.append')[0]!['audio'] as string;
    expect(Buffer.from(b64, 'base64').byteLength).toBe(960 * 2);
    await session.onMicFrame(new Int16Array(320));
    expect(ws.ofType('input_audio_buffer.append')).toHaveLength(2);
  });

  test('the instructions are the voice instructions, the tone, then the chat as it stands', async () => {
    const { deps, last } = makeDeps({ instructions: 'Be this chat.', tone: 'Warm.' });
    const ws = await open(new OpenAIRealtimeSession(makeInit(), deps), last);
    const update = ws.ofType('session.update')[0] as { session: { instructions: string } };
    expect(update.session.instructions).toBe(`Be this chat.\n\nWarm.\n\n${FAKE_START_CONTEXT}`);
    expect(ws.ofType('conversation.item.create')).toHaveLength(0);
  });

  test('a catch-up is added to the conversation when it is written, without asking for a reply', async () => {
    let write!: (text: string) => void;
    const { link } = fakeVoiceAgentLink({
      startContext: () => ({
        text: FAKE_START_CONTEXT,
        catchUp: new Promise<string>((r) => (write = r)),
      }),
    });
    const { deps, last } = makeDeps({ link });
    const ws = await open(new OpenAIRealtimeSession(makeInit(), deps), last);
    write('They chose the 09:14.');
    await vi.waitFor(() => expect(ws.ofType('conversation.item.create')).toHaveLength(1));
    const item = ws.ofType('conversation.item.create')[0]!['item'] as {
      role: string;
      content: Array<{ text: string }>;
    };
    expect(item.role).toBe('user');
    expect(item.content[0]!.text).toContain('They chose the 09:14.');
    expect(ws.ofType('response.create')).toHaveLength(0);
  });

  test('a full turn: partial words, final transcript, audio out, tts_end, back to listening', async () => {
    const { deps, last, events, binary } = makeDeps();
    const session = new OpenAIRealtimeSession(makeInit(), deps);
    const ws = await open(session, last);
    ws.serverSend({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'i1',
      delta: 'hello ',
    });
    ws.serverSend({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'i1',
      delta: 'there',
    });
    ws.serverSend({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'i1',
      transcript: 'hello there',
    });
    ws.serverSend({ type: 'response.created' });
    ws.serverSend(audioDelta(480));
    ws.serverSend(audioDelta(480));
    ws.serverSend({
      type: 'response.done',
      response: { status: 'completed', output: [{ type: 'message' }] },
    });
    expect(
      events
        .filter((e) => e.type === 'audio.transcript_partial')
        .map((e) => (e as { text: string }).text),
    ).toEqual(['hello ', 'hello there']);
    expect(events).toContainEqual({
      type: 'audio.transcript_final',
      sessionId: 'sess-1',
      text: 'hello there',
    });
    expect(binary).toHaveLength(2);
    expect(binary[0]!.length).toBe(480);
    expect(events.filter((e) => e.type === 'audio.tts_chunk')).toHaveLength(2);
    expect(events.at(-2)).toEqual({ type: 'audio.tts_end', sessionId: 'sess-1' });
    expect(session.getState()).toBe('listening');
    expect(session.stats().turns).toBe(1);
    // call mode: the provider answered on its own; we never asked it to.
    expect(ws.ofType('response.create')).toHaveLength(0);
  });

  test('pass_to_agent answers "received" at once and the voice carries on', async () => {
    const { deps, last, passed } = makeDeps();
    const session = new OpenAIRealtimeSession(makeInit(), deps);
    const ws = await open(session, last);
    ws.serverSend({ type: 'response.created' });
    ws.serverSend({
      type: 'response.function_call_arguments.done',
      call_id: 'call-1',
      name: PASS_TO_AGENT_TOOL_NAME,
      arguments: JSON.stringify({ request: 'when is my next train' }),
    });
    ws.serverSend({
      type: 'response.done',
      response: { status: 'completed', output: [{ type: 'function_call' }] },
    });
    expect(session.getState()).toBe('listening');
    await vi.waitFor(() => expect(ws.ofType('response.create')).toHaveLength(1));
    expect(passed).toEqual([
      { sessionId: 'sess-1', chatId: 'chat-1', request: 'when is my next train' },
    ]);
    const out = ws.ofType('conversation.item.create').at(-1)!['item'] as {
      type: string;
      call_id: string;
      output: string;
    };
    expect(out).toEqual({
      type: 'function_call_output',
      call_id: 'call-1',
      output: JSON.stringify({ result: 'received' }),
    });
  });

  test("the agent's answer is pushed when the line is quiet, and the voice is asked to speak", async () => {
    const { deps, last } = makeDeps();
    const session = new OpenAIRealtimeSession(makeInit(), deps);
    const ws = await open(session, last);
    ws.serverSend({ type: 'response.created' });
    session.pushMessage("Answer from the chat's agent: 14:05", { handoffSettled: true });
    // A reply is going: the push waits.
    expect(ws.ofType('conversation.item.create')).toHaveLength(0);
    ws.serverSend(audioDelta(48));
    ws.serverSend({ type: 'response.done', response: { status: 'completed' } });
    await vi.waitFor(() => expect(ws.ofType('conversation.item.create')).toHaveLength(1));
    const item = ws.ofType('conversation.item.create')[0]!['item'] as {
      content: Array<{ text: string }>;
    };
    expect(item.content[0]!.text).toContain('14:05');
    expect(ws.ofType('response.create')).toHaveLength(1);
  });

  test('a response with only a tool call and no speech is not a lost reply', async () => {
    const { deps, last, events } = makeDeps();
    const ws = await open(new OpenAIRealtimeSession(makeInit(), deps), last);
    ws.serverSend({
      type: 'response.done',
      response: { status: 'completed', output: [{ type: 'function_call' }] },
    });
    expect(events.some((e) => e.type === 'audio.error')).toBe(false);
  });

  test('a completed reply with no audio is reported loudly', async () => {
    const { deps, last, events } = makeDeps();
    const ws = await open(new OpenAIRealtimeSession(makeInit(), deps), last);
    ws.serverSend({
      type: 'response.done',
      response: { status: 'completed', output: [{ type: 'message' }] },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'audio.error',
        code: 'openai_unavailable',
        message: expect.stringContaining('no audio'),
      }),
    );
  });

  test('a failed response, an error event, and a failed transcription all surface as openai_unavailable', async () => {
    const { deps, last, events, onFatal } = makeDeps();
    const ws = await open(new OpenAIRealtimeSession(makeInit(), deps), last);
    ws.serverSend({
      type: 'response.done',
      response: { status: 'failed', status_details: { error: { message: 'insufficient_quota' } } },
    });
    ws.serverSend({ type: 'error', error: { code: 'rate_limit_exceeded', message: 'slow down' } });
    ws.serverSend({
      type: 'conversation.item.input_audio_transcription.failed',
      item_id: 'i9',
      error: { message: 'bad audio' },
    });
    const errors = events.filter((e) => e.type === 'audio.error') as Array<{
      code: string;
      message: string;
    }>;
    expect(errors.map((e) => e.code)).toEqual([
      'openai_unavailable',
      'openai_unavailable',
      'openai_unavailable',
    ]);
    expect(errors[0]!.message).toContain('insufficient_quota');
    expect(errors[1]!.message).toContain('rate_limit_exceeded');
    expect(errors[2]!.message).toContain('bad audio');
    // Mid-session errors are loud but not fatal — the provider socket is still up.
    expect(onFatal).not.toHaveBeenCalled();
  });

  test('barge-in cuts the reply in OpenAI and in the chat to what had played', async () => {
    const { deps, last, timeline } = makeDeps();
    const session = new OpenAIRealtimeSession(makeInit(), deps);
    const ws = await open(session, last);
    ws.serverSend({ type: 'response.created' });
    ws.serverSend({
      type: 'response.output_audio_transcript.delta',
      delta: 'Once upon a time there was a very long story indeed.',
    });
    // Two seconds of audio for item a1, all sent at once; the user cuts in after a fraction of it.
    ws.serverSend({ ...audioDelta(48_000), item_id: 'a1' });
    await new Promise((r) => setTimeout(r, 600));
    ws.serverSend({ type: 'input_audio_buffer.speech_started' });
    const truncate = ws.ofType('conversation.item.truncate')[0] as {
      item_id: string;
      content_index: number;
      audio_end_ms: number;
    };
    expect(truncate).toMatchObject({ item_id: 'a1', content_index: 0 });
    expect(truncate.audio_end_ms).toBeGreaterThanOrEqual(500);
    expect(truncate.audio_end_ms).toBeLessThan(2000);
    // Whatever still streams of the cancelled reply is not written.
    ws.serverSend({ type: 'response.output_audio_transcript.delta', delta: ' The end.' });
    ws.serverSend({ type: 'response.done', response: { status: 'cancelled' } });
    const written = timeline.log.filter((l) => l.startsWith('reply:'));
    expect(written).toHaveLength(1);
    expect(written[0]!).toMatch(/^reply:chat-1:Once upon/);
    expect(written[0]!).not.toContain('The end.');
    expect(written[0]!.length).toBeLessThan(
      'reply:chat-1:Once upon a time there was a very long story indeed.'.length,
    );
  });

  test('barge-in in a call: speech_started while speaking flushes the surface', async () => {
    const { deps, last, events } = makeDeps();
    const session = new OpenAIRealtimeSession(makeInit(), deps);
    const ws = await open(session, last);
    ws.serverSend(audioDelta(240));
    expect(session.getState()).toBe('speaking');
    ws.serverSend({ type: 'input_audio_buffer.speech_started' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'audio.barge_in' }));
    expect(events).toContainEqual({ type: 'audio.tts_end', sessionId: 'sess-1', bargedIn: true });
    ws.serverSend({ type: 'response.done', response: { status: 'cancelled' } });
    // No second tts_end for the cancelled reply.
    expect(events.filter((e) => e.type === 'audio.tts_end')).toHaveLength(1);
    expect(session.getState()).toBe('listening');
  });

  describe('hands-free (address-gated)', () => {
    test('the provider is told not to answer or be interrupted on its own', async () => {
      const { deps, last } = makeDeps();
      const ws = await open(
        new OpenAIRealtimeSession(makeInit({ mode: 'hands-free' }), deps),
        last,
      );
      const td = (
        ws.ofType('session.update')[0] as {
          session: { audio: { input: { turn_detection: Record<string, unknown> } } };
        }
      ).session.audio.input.turn_detection;
      expect(td).toMatchObject({ create_response: false, interrupt_response: false });
    });

    test('an unaddressed utterance is heard-but-not-sent and deleted from the conversation', async () => {
      const { deps, last, events } = makeDeps();
      const session = new OpenAIRealtimeSession(
        makeInit({ mode: 'hands-free', addressWord: 'patch' }),
        deps,
      );
      const ws = await open(session, last);
      ws.serverSend({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'i2',
        transcript: 'pass me the trowel',
      });
      expect(events).toContainEqual({
        type: 'audio.transcript_final',
        sessionId: 'sess-1',
        text: 'pass me the trowel',
        addressed: false,
      });
      expect(ws.ofType('conversation.item.delete')).toEqual([
        { type: 'conversation.item.delete', item_id: 'i2' },
      ]);
      expect(ws.ofType('response.create')).toHaveLength(0);
      expect(session.stats().turns).toBe(0);
    });

    test('an addressed utterance becomes a turn: we ask the provider to answer', async () => {
      const { deps, last, events } = makeDeps();
      const session = new OpenAIRealtimeSession(
        makeInit({ mode: 'hands-free', addressWord: 'patch' }),
        deps,
      );
      const ws = await open(session, last);
      ws.serverSend({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'i3',
        transcript: 'Hatch, what time is it',
      });
      expect(events).toContainEqual({
        type: 'audio.transcript_final',
        sessionId: 'sess-1',
        text: 'Hatch, what time is it',
      });
      expect(ws.ofType('response.create')).toHaveLength(1);
      expect(ws.ofType('conversation.item.delete')).toHaveLength(0);
    });

    test('switching mode re-configures the provider turn detection in place', async () => {
      const { deps, last } = makeDeps();
      const session = new OpenAIRealtimeSession(makeInit(), deps);
      const ws = await open(session, last);
      session.setMode('hands-free');
      const updates = ws.ofType('session.update') as Array<{
        session: { audio: { input: { turn_detection: Record<string, unknown> } } };
      }>;
      expect(updates).toHaveLength(2);
      expect(updates[1]!.session.audio.input.turn_detection).toMatchObject({
        create_response: false,
      });
      expect(session.getMode()).toBe('hands-free');
      session.setMode('hands-free');
      expect(ws.ofType('session.update')).toHaveLength(2);
    });

    test('in hands-free, somebody else talking over a reply does not barge in', async () => {
      const { deps, last, events } = makeDeps();
      const ws = await open(
        new OpenAIRealtimeSession(makeInit({ mode: 'hands-free' }), deps),
        last,
      );
      ws.serverSend(audioDelta(240));
      ws.serverSend({ type: 'input_audio_buffer.speech_started' });
      expect(events.some((e) => e.type === 'audio.barge_in')).toBe(false);
    });
  });

  describe('fatal failures end the surface session (NO SILENT FALLBACK)', () => {
    test('the socket never opens', async () => {
      const { deps, last, events, onFatal } = makeDeps();
      const session = new OpenAIRealtimeSession(makeInit(), deps);
      session.onSessionStart();
      await vi.waitFor(() => expect(last.ws).toBeDefined());
      last.ws!.emit('error', new Error('ECONNREFUSED'));
      await vi.waitFor(() => expect(onFatal).toHaveBeenCalledTimes(1));
      expect(events).toEqual([
        expect.objectContaining({
          type: 'audio.error',
          code: 'openai_unavailable',
          message: expect.stringContaining('ECONNREFUSED'),
        }),
      ]);
    });

    test('the provider rejects the session config', async () => {
      const { deps, last, events, onFatal } = makeDeps();
      const session = new OpenAIRealtimeSession(makeInit(), deps);
      session.onSessionStart();
      await vi.waitFor(() => expect(last.ws).toBeDefined());
      last.ws!.emit('open');
      await vi.waitFor(() => expect(last.ws!.ofType('session.update')).toHaveLength(1));
      last.ws!.serverSend({
        type: 'error',
        error: { code: 'invalid_api_key', message: 'Incorrect API key' },
      });
      await vi.waitFor(() => expect(onFatal).toHaveBeenCalledTimes(1));
      expect(events[0]).toMatchObject({
        code: 'openai_unavailable',
        message: expect.stringContaining('invalid_api_key'),
      });
      expect(session.getState()).toBe('connecting');
    });

    test('the provider hangs up mid-call; later mic frames are dropped', async () => {
      const { deps, last, events, onFatal } = makeDeps();
      const session = new OpenAIRealtimeSession(makeInit(), deps);
      const ws = await open(session, last);
      ws.emit('close', 1006, Buffer.from(''));
      expect(onFatal).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toMatchObject({
        code: 'openai_unavailable',
        message: expect.stringContaining('1006'),
      });
      const before = ws.ofType('input_audio_buffer.append').length;
      await session.onMicFrame(new Int16Array(320));
      expect(ws.ofType('input_audio_buffer.append')).toHaveLength(before);
    });

    test('our own close() is not a failure', async () => {
      const { deps, last, events, onFatal } = makeDeps();
      const session = new OpenAIRealtimeSession(makeInit(), deps);
      const ws = await open(session, last);
      await session.close();
      ws.emit('close', 1000, Buffer.from(''));
      expect(ws.closed).toBe(true);
      expect(onFatal).not.toHaveBeenCalled();
      expect(events.some((e) => e.type === 'audio.error')).toBe(false);
    });
  });

  test('speak() asks for an out-of-band verbatim reply; injectTranscript() drives a real turn', async () => {
    const { deps, last } = makeDeps();
    const session = new OpenAIRealtimeSession(makeInit(), deps);
    const ws = await open(session, last);
    await session.speak('Your parcel is here');
    expect(ws.ofType('response.create')[0]).toMatchObject({
      response: {
        conversation: 'none',
        instructions: expect.stringContaining('Your parcel is here'),
      },
    });
    await session.injectTranscript('hello');
    expect(ws.ofType('conversation.item.create').at(-1)).toMatchObject({
      item: { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    });
    expect(ws.ofType('response.create')).toHaveLength(2);
    expect(await session.finalizeNote()).toBe(false);
    session.setFocus('chat-2');
    expect(session.getCurrentChatId()).toBe('chat-2');
  });
});

// spec/07 § Keeping voice and text as one conversation / § Call cost.
describe('one conversation with the chat', () => {
  test('writes the user words before the reply even when the transcript lands after the reply starts', async () => {
    const { deps, last, timeline } = makeDeps();
    const session = new OpenAIRealtimeSession(makeInit(), deps);
    const ws = await open(session, last);

    ws.serverSend({ type: 'input_audio_buffer.speech_started' });
    ws.serverSend({ type: 'response.created' });
    ws.serverSend({ type: 'response.output_audio_transcript.delta', delta: 'A cloud ' });
    ws.serverSend(audioDelta(48));
    expect(timeline.log).toEqual([]);
    ws.serverSend({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'i1',
      transcript: 'what is a nebula',
    });
    ws.serverSend({ type: 'response.output_audio_transcript.delta', delta: 'of gas.' });
    ws.serverSend({ type: 'response.done', response: { status: 'completed' } });

    // Written once it has played out.
    await vi.waitFor(() => expect(timeline.log.at(-1)).toMatch(/^reply:/));
    expect(timeline.log).toEqual([
      'user:chat-1:what is a nebula',
      'begin:chat-1',
      'delta:A cloud ',
      'delta:of gas.',
      'reply:chat-1:A cloud of gas.',
    ]);
  });

  test("a hand-off goes to the chat's agent, and what the voice says of the answer is written too", async () => {
    const { deps, last, timeline, passed } = makeDeps();
    const session = new OpenAIRealtimeSession(makeInit(), deps);
    const ws = await open(session, last);

    ws.serverSend({ type: 'input_audio_buffer.speech_started' });
    ws.serverSend({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'i1',
      transcript: 'when is my train',
    });
    ws.serverSend({ type: 'response.created' });
    ws.serverSend({ type: 'response.output_audio_transcript.delta', delta: 'Passing that on.' });
    ws.serverSend(audioDelta(48));
    ws.serverSend({
      type: 'response.function_call_arguments.done',
      name: PASS_TO_AGENT_TOOL_NAME,
      call_id: 'c1',
      arguments: JSON.stringify({ request: 'Next train home' }),
    });
    ws.serverSend({ type: 'response.done', response: { status: 'completed' } });
    await vi.waitFor(() => expect(passed).toHaveLength(1));
    expect(passed[0]!.request).toBe('Next train home');
    await vi.waitFor(() => expect(ws.ofType('response.create').length).toBeGreaterThan(0));
    ws.serverSend({ type: 'response.created' });
    ws.serverSend({ type: 'response.output_audio_transcript.delta', delta: 'Passed on.' });
    ws.serverSend(audioDelta(48));
    ws.serverSend({ type: 'response.done', response: { status: 'completed' } });
    session.pushMessage("Answer from the chat's agent: 14:05", { handoffSettled: true });
    await vi.waitFor(() => expect(ws.ofType('response.create').length).toBe(2));
    ws.serverSend({ type: 'response.created' });
    ws.serverSend({ type: 'response.output_audio_transcript.delta', delta: 'It is at 14:05.' });
    ws.serverSend(audioDelta(48));
    ws.serverSend({ type: 'response.done', response: { status: 'completed' } });

    // Each reply is written once it has played out.
    await vi.waitFor(() =>
      expect(timeline.log.filter((l) => l.startsWith('reply:'))).toHaveLength(3),
    );
    expect(timeline.log.filter((l) => l.startsWith('reply:') || l.startsWith('user:'))).toEqual([
      'user:chat-1:when is my train',
      'reply:chat-1:Passing that on.',
      'reply:chat-1:Passed on.',
      'reply:chat-1:It is at 14:05.',
    ]);
  });

  test('look_back and check_status are answered at once from the host', async () => {
    const { deps, last, link } = makeDeps();
    const ws = await open(new OpenAIRealtimeSession(makeInit({ chatId: 'chat-9' }), deps), last);
    ws.serverSend({
      type: 'response.function_call_arguments.done',
      name: 'look_back',
      call_id: 'lb1',
      arguments: JSON.stringify({ query: 'archived' }),
    });
    ws.serverSend({
      type: 'response.function_call_arguments.done',
      name: 'check_status',
      call_id: 'cs1',
      arguments: '{}',
    });
    await vi.waitFor(() => expect(link.lookBack).toHaveBeenCalledWith('chat-9', 'archived'));
    await vi.waitFor(() => expect(link.checkStatus).toHaveBeenCalledWith('sess-1', 'chat-9'));
    const outs = ws
      .ofType('conversation.item.create')
      .map((m) => m['item'] as { type: string; output?: string })
      .filter((i) => i.type === 'function_call_output')
      .map((i) => JSON.parse(i.output!) as { result: string });
    expect(outs).toEqual([
      { result: 'found in chat-9: dentist on Tuesday' },
      { result: 'status of chat-9' },
    ]);
  });

  test('tallies the usage each response reports', async () => {
    const { deps, last } = makeDeps();
    const session = new OpenAIRealtimeSession(makeInit(), deps);
    const ws = await open(session, last);
    const usage = (text: number, audio: number, cached: number, outAudio: number) => ({
      input_tokens: text + audio,
      output_tokens: outAudio,
      input_token_details: {
        text_tokens: text,
        audio_tokens: audio,
        cached_tokens: cached,
        cached_tokens_details: { text_tokens: 0, audio_tokens: cached },
      },
      output_token_details: { text_tokens: 0, audio_tokens: outAudio },
    });
    ws.serverSend(audioDelta(48));
    ws.serverSend({
      type: 'response.done',
      response: { status: 'completed', usage: usage(100, 200, 50, 30) },
    });
    ws.serverSend(audioDelta(48));
    ws.serverSend({
      type: 'response.done',
      response: { status: 'completed', usage: usage(10, 20, 0, 5) },
    });
    // Cached tokens are a subset of the input counts and priced separately.
    expect(session.engineCosting()).toEqual({
      backend: 'openai',
      model: 'gpt-realtime-2.1-mini',
      tokens: { textIn: 110, audioIn: 170, cachedIn: 50, textOut: 0, audioOut: 35 },
      stt: null,
    });
  });
});

// ---------------------------------------------------------------------------
// spec/16 § Speaking aloud, § Who is speaking — a voice device's session.
// ---------------------------------------------------------------------------

describe('a voice device session', () => {
  const axis = (i: number): number[] => {
    const v = new Array<number>(256).fill(0);
    v[i] = 1;
    return v;
  };
  const TOM: VoiceProfile = {
    id: 'p-tom',
    name: 'Tom',
    access: 'owner',
    context: 'Likes trains.',
    voiceprint: axis(0),
    samples: 3,
  };
  const ELEANOR: VoiceProfile = {
    id: 'p-el',
    name: 'Eleanor',
    access: 'household',
    context: 'Has a dentist on Fridays.',
    voiceprint: axis(1),
    samples: 3,
  };
  /** The fake speaker model: mic level 1000 is Tom, 2000 is Eleanor, anything else a stranger. */
  const embed = vi.fn(async (pcm: Int16Array) =>
    pcm[0] === 1000 ? axis(0) : pcm[0] === 2000 ? axis(1) : axis(7),
  );

  function deviceDeps(profiles: VoiceProfile[], extra: Partial<OpenAIRealtimeDeps> = {}) {
    const recent = new RecentVoices();
    const made = makeDeps({
      device: { prompt: () => 'SPOKEN ALOUD RULES', profiles: () => profiles, embed, recent },
      link: fakeVoiceAgentLink({
        startContext: () => ({ text: 'User: my bank balance is private', catchUp: null }),
      }).link,
      ...extra,
    });
    return { ...made, recent };
  }

  /** Two seconds of one voice, then the provider's VAD marks it. */
  async function speak(
    session: OpenAIRealtimeSession,
    ws: FakeOpenAIWs,
    level: number,
    item: string,
    startMs: number,
  ): Promise<void> {
    ws.serverSend({
      type: 'input_audio_buffer.speech_started',
      item_id: item,
      audio_start_ms: startMs,
    });
    for (let i = 0; i < 100; i++) await session.onMicFrame(new Int16Array(320).fill(level));
    ws.serverSend({
      type: 'input_audio_buffer.speech_stopped',
      item_id: item,
      audio_end_ms: startMs + 2000,
    });
  }

  const instructions = (ws: FakeOpenAIWs, i: number): string =>
    (ws.ofType('session.update')[i] as { session: { instructions: string } }).session.instructions;
  const toolNames = (ws: FakeOpenAIWs, i: number): string[] =>
    (
      ws.ofType('session.update')[i] as { session: { tools: Array<{ name: string }> } }
    ).session.tools.map((t) => t.name);

  test('is told it is heard out loud, and keeps each voice for enrolment', async () => {
    const { deps, last, recent } = deviceDeps([]);
    const session = new OpenAIRealtimeSession(makeInit({ surfaceKind: 'device' }), deps);
    const ws = await open(session, last);
    expect(instructions(ws, 0)).toContain('SPOKEN ALOUD RULES');
    // No profiles: answered as before, by the provider's own VAD, history and all.
    expect(instructions(ws, 0)).toContain('my bank balance is private');
    await speak(session, ws, 3000, 'i1', 0);
    await vi.waitFor(() => expect(recent.list()).toHaveLength(1));
    expect(ws.ofType('response.create')).toHaveLength(0);
    ws.serverSend({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'i1',
      transcript: 'hello there',
    });
    expect(recent.list()[0]!.text).toBe('hello there');
  });

  test('with profiles, starts treating the speaker as a stranger: no history, no agent', async () => {
    const { deps, last } = deviceDeps([TOM, ELEANOR]);
    const ws = await open(
      new OpenAIRealtimeSession(makeInit({ surfaceKind: 'device' }), deps),
      last,
    );
    const first = instructions(ws, 0);
    expect(first).toContain('someone you do not recognise');
    expect(first).not.toContain('my bank balance is private');
    expect(toolNames(ws, 0)).not.toContain(PASS_TO_AGENT_TOOL_NAME);
    const update = ws.ofType('session.update')[0] as {
      session: { audio: { input: { turn_detection: { create_response: boolean } } } };
    };
    expect(update.session.audio.input.turn_detection.create_response).toBe(false);
  });

  test('recognises the owner before replying, and gives them the history and the agent', async () => {
    const { deps, last, timeline } = deviceDeps([TOM, ELEANOR]);
    const session = new OpenAIRealtimeSession(makeInit({ surfaceKind: 'device' }), deps);
    const ws = await open(session, last);
    await speak(session, ws, 1000, 'i1', 0);
    await vi.waitFor(() => expect(ws.ofType('response.create')).toHaveLength(1));
    // The speaker's session.update goes out before the reply is asked for.
    const order = ws.sent.map((m) => m['type']).filter((t) => t !== 'input_audio_buffer.append');
    expect(order.slice(-2)).toEqual(['session.update', 'response.create']);
    expect(instructions(ws, 1)).toContain("Tom, the account's owner");
    expect(instructions(ws, 1)).toContain('my bank balance is private');
    expect(toolNames(ws, 1)).toContain(PASS_TO_AGENT_TOOL_NAME);
    expect(session.getSpeaker()?.name).toBe('Tom');
    ws.serverSend({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'i1',
      transcript: 'what is on today',
    });
    expect(timeline.log).toContain('user:chat-1:Tom: what is on today');
  });

  test("a household member's hand-off tells the agent who asked; the history stays out", async () => {
    const passed: Array<{ request: string }> = [];
    const { deps, last } = deviceDeps([TOM, ELEANOR], {
      link: fakeVoiceAgentLink({
        startContext: () => ({ text: 'User: my bank balance is private', catchUp: null }),
        passToAgent: (req) => passed.push(req),
      }).link,
    });
    const session = new OpenAIRealtimeSession(makeInit({ surfaceKind: 'device' }), deps);
    const ws = await open(session, last);
    await speak(session, ws, 2000, 'i1', 0);
    await vi.waitFor(() => expect(session.getSpeaker()?.name).toBe('Eleanor'));
    expect(instructions(ws, 1)).not.toContain('my bank balance is private');
    expect(toolNames(ws, 1)).toContain(PASS_TO_AGENT_TOOL_NAME);
    ws.serverSend({
      type: 'response.function_call_arguments.done',
      name: PASS_TO_AGENT_TOOL_NAME,
      call_id: 'c1',
      arguments: JSON.stringify({ request: 'when is my dentist' }),
    });
    await vi.waitFor(() => expect(passed).toHaveLength(1));
    const message = passed[0]!.request;
    expect(message).toMatch(
      /^\[Spoken by Eleanor, a member of the household\. About Eleanor: Has a dentist/,
    );
    expect(message).toContain('when is my dentist');
  });

  test("a stranger's hand-off is refused in code and never reaches the agent", async () => {
    const passed: Array<{ request: string }> = [];
    const { deps, last } = deviceDeps([TOM], {
      link: fakeVoiceAgentLink({ passToAgent: (req) => passed.push(req) }).link,
    });
    const session = new OpenAIRealtimeSession(makeInit({ surfaceKind: 'device' }), deps);
    const ws = await open(session, last);
    await speak(session, ws, 5000, 'i1', 0);
    await vi.waitFor(() => expect(ws.ofType('response.create')).toHaveLength(1));
    expect(session.getSpeaker()).toBeNull();
    ws.serverSend({
      type: 'response.function_call_arguments.done',
      name: PASS_TO_AGENT_TOOL_NAME,
      call_id: 'c1',
      arguments: JSON.stringify({ request: "what is Tom's bank balance" }),
    });
    await vi.waitFor(() => expect(ws.ofType('response.create')).toHaveLength(2));
    expect(passed).toHaveLength(0);
    const out = ws.ofType('conversation.item.create').at(-1) as {
      item: { type: string; output: string };
    };
    expect(out.item.type).toBe('function_call_output');
    expect(out.item.output).toContain('Refused');
  });

  test('words that land before the voiceprint wait for it: labelled right, kept for enrolment', async () => {
    let release: () => void = () => {};
    const slow = vi.fn(
      (pcm: Int16Array) =>
        new Promise<number[]>((resolve) => {
          release = () => resolve(pcm[0] === 1000 ? axis(0) : axis(7));
        }),
    );
    const recent = new RecentVoices();
    const { deps, last, timeline } = makeDeps({
      device: { prompt: () => '', profiles: () => [TOM], embed: slow, recent },
    });
    const session = new OpenAIRealtimeSession(makeInit({ surfaceKind: 'device' }), deps);
    const ws = await open(session, last);
    await speak(session, ws, 1000, 'i1', 0);
    ws.serverSend({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'i1',
      transcript: 'good morning',
    });
    expect(timeline.log.filter((l) => l.startsWith('user:'))).toHaveLength(0);
    release();
    await vi.waitFor(() => expect(timeline.log).toContain('user:chat-1:Tom: good morning'));
    expect(recent.list()[0]!.text).toBe('good morning');
  });

  test('a reply asked for while another is still being spoken follows it', async () => {
    const { deps, last } = deviceDeps([TOM]);
    const session = new OpenAIRealtimeSession(makeInit({ surfaceKind: 'device' }), deps);
    const ws = await open(session, last);
    ws.serverSend({ type: 'response.created' });
    await speak(session, ws, 1000, 'i1', 0);
    await vi.waitFor(() => expect(session.getSpeaker()?.name).toBe('Tom'));
    expect(ws.ofType('response.create')).toHaveLength(0);
    ws.serverSend({ type: 'response.done', response: { status: 'cancelled' } });
    expect(ws.ofType('response.create')).toHaveLength(1);
  });

  test("a voice below the account's threshold is not recognised", async () => {
    const near = axis(0).map((x, i) => (i === 1 ? 0.75 : x)); // cosine 0.8 to Tom
    const { deps, last } = makeDeps({
      device: {
        prompt: () => '',
        profiles: () => [TOM],
        threshold: () => 0.85,
        embed: async () => near,
        recent: new RecentVoices(),
      },
    });
    const session = new OpenAIRealtimeSession(makeInit({ surfaceKind: 'device' }), deps);
    const ws = await open(session, last);
    await speak(session, ws, 1000, 'i1', 0);
    await vi.waitFor(() => expect(ws.ofType('response.create')).toHaveLength(1));
    expect(session.getSpeaker()).toBeNull();
  });

  test('a word too short to tell keeps the speaker and still gets its reply', async () => {
    const { deps, last } = deviceDeps([TOM]);
    const session = new OpenAIRealtimeSession(makeInit({ surfaceKind: 'device' }), deps);
    const ws = await open(session, last);
    await speak(session, ws, 1000, 'i1', 0);
    await vi.waitFor(() => expect(session.getSpeaker()?.name).toBe('Tom'));
    embed.mockClear();
    ws.serverSend({
      type: 'input_audio_buffer.speech_started',
      item_id: 'i2',
      audio_start_ms: 3000,
    });
    for (let i = 0; i < 10; i++) await session.onMicFrame(new Int16Array(320).fill(5000));
    ws.serverSend({ type: 'input_audio_buffer.speech_stopped', item_id: 'i2', audio_end_ms: 3200 });
    await vi.waitFor(() => expect(ws.ofType('response.create')).toHaveLength(2));
    expect(embed).not.toHaveBeenCalled();
    expect(session.getSpeaker()?.name).toBe('Tom');
  });
});
