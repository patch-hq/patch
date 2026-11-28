// ElevenLabs Agents session unit tests. Both the REST API and the conversation
// socket are in-memory fakes — ElevenLabs is a paid API and nothing here may reach it.

import { describe, test, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import {
  ElevenLabsAgentSession,
  type ElevenLabsAgentDeps,
  type ElevenLabsWsCtor,
} from '../src/audio/elevenlabs-agent.js';
import { DEFAULT_VOICE_INSTRUCTIONS } from '@patch/wire';
import { LOOK_BACK_TOOL_NAME, PASS_TO_AGENT_TOOL_NAME } from '../src/audio/voiceAgent.js';
import { fakeVoiceAgentLink, FAKE_START_CONTEXT } from './helpers/fakeVoiceAgentLink.js';
import type { SessionInit } from '../src/audio/session.js';
import type { AudioEvent, AudioSessionMode } from '@patch/wire/audio';
import { FakeTimeline } from './gemini-live-session.test.js';

const logger = pino({ level: 'silent' });

class FakeWs extends EventEmitter {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  constructor(public readonly url: string) {
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

interface RestCall {
  method: string;
  path: string;
  key: string | null;
  body: Record<string, any> | undefined;
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

function makeDeps(overrides: Partial<ElevenLabsAgentDeps> = {}, failPath?: string) {
  const events: AudioEvent[] = [];
  const binary: Int16Array[] = [];
  const rest: RestCall[] = [];
  const last: { ws?: FakeWs } = {};
  const { link, passed } = fakeVoiceAgentLink();
  const onFatal = vi.fn();
  const timeline = new FakeTimeline();
  let n = 0;
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const path = u.pathname + u.search;
    const headers = init.headers as Record<string, string>;
    rest.push({
      method: init.method ?? 'GET',
      path,
      key: headers['xi-api-key'] ?? null,
      body: init.body ? (JSON.parse(init.body as string) as Record<string, any>) : undefined,
    });
    if (failPath && path.startsWith(failPath))
      return new Response('quota exceeded', { status: 429 });
    if (path === '/v1/convai/tools') return Response.json({ id: `tool-${++n}` });
    if (path === '/v1/convai/agents/create') return Response.json({ agent_id: 'agent-1' });
    if (path.startsWith('/v1/convai/conversation/get-signed-url'))
      return Response.json({ signed_url: 'wss://signed.example/conv?token=t' });
    return Response.json({});
  });
  const wsCtor = function (this: unknown, url: string) {
    last.ws = new FakeWs(url);
    return last.ws;
  } as unknown as ElevenLabsWsCtor;
  const deps: ElevenLabsAgentDeps = {
    logger,
    sendAudio: (ev) => events.push(ev),
    sendBinary: (pcm) => binary.push(pcm),
    link,
    instructions: DEFAULT_VOICE_INSTRUCTIONS,
    apiKey: 'e-key',
    llm: 'claude-haiku-4-5',
    wsCtor,
    fetchImpl: fetchImpl as unknown as ElevenLabsAgentDeps['fetchImpl'],
    onFatal,
    timeline,
    ...overrides,
  };
  return { deps, events, binary, rest, last, passed, link, onFatal, timeline };
}

const metadata = (out = 'pcm_24000', inp = 'pcm_16000') => ({
  type: 'conversation_initiation_metadata',
  conversation_initiation_metadata_event: {
    conversation_id: 'conv-1',
    agent_output_audio_format: out,
    user_input_audio_format: inp,
  },
});

async function open(session: ElevenLabsAgentSession, last: { ws?: FakeWs }): Promise<FakeWs> {
  session.onSessionStart();
  await vi.waitFor(() => expect(last.ws).toBeDefined());
  const ws = last.ws!;
  ws.emit('open');
  await vi.waitFor(() => expect(ws.ofType('conversation_initiation_client_data')).toHaveLength(1));
  ws.serverSend(metadata());
  await vi.waitFor(() => expect(session.getState()).toBe('listening'));
  return ws;
}

const audioChunk = (samples: number) => ({
  type: 'audio',
  audio_event: {
    audio_base_64: Buffer.from(new Int16Array(samples).fill(1000).buffer).toString('base64'),
    event_id: 1,
  },
});
/** The end of a reply (asked for in the agent's `client_events`). */
const complete = {
  type: 'agent_response_complete',
  agent_response_complete_event: { event_id: 1 },
};
const transcript = (text: string) => ({
  type: 'user_transcript',
  user_transcription_event: { user_transcript: text },
});
const response = (text: string) => ({
  type: 'agent_response',
  agent_response_event: { agent_response: text },
});
const toolCall = (name: string, parameters: unknown, id = 'call-1') => ({
  type: 'client_tool_call',
  client_tool_call: { tool_name: name, tool_call_id: id, parameters },
});

describe('ElevenLabsAgentSession — provisioning', () => {
  test('creates the voice agent tools and an agent on the chosen LLM, then dials the signed URL', async () => {
    const { deps, rest, last } = makeDeps({ instructions: 'Be this chat.' });
    const session = new ElevenLabsAgentSession(makeInit(), deps);
    const ws = await open(session, last);
    expect(rest.every((r) => r.key === 'e-key')).toBe(true);
    const tools = rest.filter((r) => r.path === '/v1/convai/tools');
    expect(tools.map((t) => t.body!['tool_config'].name)).toEqual([
      PASS_TO_AGENT_TOOL_NAME,
      'check_status',
      LOOK_BACK_TOOL_NAME,
      'find_chats',
      'chat_status',
      'end_call',
      'switch_chat',
    ]);
    expect(tools[0]!.body!['tool_config'].type).toBe('client');
    expect(tools[0]!.body!['tool_config'].expects_response).toBe(true);
    const agent = rest.find((r) => r.path === '/v1/convai/agents/create')!.body!;
    expect(agent['conversation_config'].agent.prompt.llm).toBe('claude-haiku-4-5');
    expect(agent['conversation_config'].agent.prompt.tool_ids).toEqual([
      'tool-1',
      'tool-2',
      'tool-3',
      'tool-4',
      'tool-5',
      'tool-6',
      'tool-7',
    ]);
    // The user's instructions, then the chat as it stands: nothing else.
    expect(agent['conversation_config'].agent.prompt.prompt).toBe(
      `Be this chat.\n\n${FAKE_START_CONTEXT}`,
    );
    expect(agent['conversation_config'].agent.first_message).toBe('');
    expect(agent['conversation_config'].conversation.max_duration_seconds).toBe(3600);
    // The end of a reply is only sent when asked for, and naming events replaces
    // the default set, so every event the session handles is named.
    expect(agent['conversation_config'].conversation.client_events).toEqual([
      'conversation_initiation_metadata',
      'ping',
      'audio',
      'interruption',
      'user_transcript',
      'agent_response',
      'agent_response_correction',
      'agent_response_complete',
      'client_tool_call',
    ]);
    expect(agent['conversation_config'].asr.user_input_audio_format).toBe('pcm_16000');
    expect(agent['conversation_config'].tts.agent_output_audio_format).toBe('pcm_24000');
    expect(rest.some((r) => r.path.includes('get-signed-url?agent_id=agent-1'))).toBe(true);
    expect(ws.url).toBe('wss://signed.example/conv?token=t');
  });

  test('handoff never registers no pass-to-agent or status tool', async () => {
    const { deps, rest, last } = makeDeps({ handoff: 'never' });
    await open(new ElevenLabsAgentSession(makeInit(), deps), last);
    expect(
      rest.filter((r) => r.path === '/v1/convai/tools').map((t) => t.body!['tool_config'].name),
    ).toEqual([LOOK_BACK_TOOL_NAME, 'find_chats', 'chat_status', 'end_call', 'switch_chat']);
  });

  test('close deletes the throwaway agent and its tools', async () => {
    const { deps, rest, last } = makeDeps();
    const session = new ElevenLabsAgentSession(makeInit(), deps);
    const ws = await open(session, last);
    await session.close();
    expect(ws.closed).toBe(true);
    expect(rest.filter((r) => r.method === 'DELETE').map((r) => r.path)).toEqual([
      '/v1/convai/agents/agent-1',
      '/v1/convai/tools/tool-1?force=true',
      '/v1/convai/tools/tool-2?force=true',
      '/v1/convai/tools/tool-3?force=true',
      '/v1/convai/tools/tool-4?force=true',
      '/v1/convai/tools/tool-5?force=true',
      '/v1/convai/tools/tool-6?force=true',
      '/v1/convai/tools/tool-7?force=true',
    ]);
  });

  test('hitting the max call duration is reported as a time limit, not a generic close', async () => {
    const { deps, events, onFatal, last } = makeDeps();
    const session = new ElevenLabsAgentSession(makeInit(), deps);
    const ws = await open(session, last);
    ws.emit('close', 1000, Buffer.from('Max call duration exceeded'));
    expect(onFatal).toHaveBeenCalled();
    const err = events.find((e) => e.type === 'audio.error') as { message: string };
    expect(err.message).toBe('The call reached its time limit. Retry to continue.');
  });

  test('a rejected provisioning call is fatal and reported — no fallback', async () => {
    const { deps, events, onFatal, last } = makeDeps({}, '/v1/convai/agents/create');
    new ElevenLabsAgentSession(makeInit(), deps).onSessionStart();
    await vi.waitFor(() => expect(onFatal).toHaveBeenCalled());
    expect(last.ws).toBeUndefined();
    const err = events.find((e) => e.type === 'audio.error') as { code: string; message: string };
    expect(err.code).toBe('elevenlabs_unavailable');
    expect(err.message).toContain('HTTP 429');
  });

  test('a conversation in the wrong audio format is fatal', async () => {
    const { deps, events, onFatal, last } = makeDeps();
    const session = new ElevenLabsAgentSession(makeInit(), deps);
    session.onSessionStart();
    await vi.waitFor(() => expect(last.ws).toBeDefined());
    last.ws!.emit('open');
    await vi.waitFor(() =>
      expect(last.ws!.ofType('conversation_initiation_client_data')).toHaveLength(1),
    );
    last.ws!.serverSend(metadata('pcm_16000'));
    await vi.waitFor(() => expect(onFatal).toHaveBeenCalled());
    expect((events.find((e) => e.type === 'audio.error') as { message: string }).message).toContain(
      'expected pcm_16000 / pcm_24000',
    );
  });

  test('an agent that never initiates fails the call, naming the stalled stage', async () => {
    const { deps, events, onFatal, last } = makeDeps({ setupTimeoutMs: 1500 });
    const session = new ElevenLabsAgentSession(makeInit(), deps);
    session.onSessionStart();
    await vi.waitFor(() => expect(last.ws).toBeDefined());
    last.ws!.emit('open');
    await vi.waitFor(() => expect(onFatal).toHaveBeenCalled(), { timeout: 4000 });
    const err = events.find((e) => e.type === 'audio.error') as { message: string };
    expect(err.message).toContain('did not start within');
    expect(err.message).toContain('waiting for the agent to initiate');
  });
});

describe('ElevenLabsAgentSession — conversation', () => {
  test('mic frames queue until the conversation opens, then go as base64 user_audio_chunk', async () => {
    const { deps, last } = makeDeps();
    const session = new ElevenLabsAgentSession(makeInit(), deps);
    session.onSessionStart();
    await session.onMicFrame(Int16Array.from([1, 2, 3, 4]));
    await vi.waitFor(() => expect(last.ws).toBeDefined());
    last.ws!.emit('open');
    await vi.waitFor(() =>
      expect(last.ws!.ofType('conversation_initiation_client_data')).toHaveLength(1),
    );
    last.ws!.serverSend(metadata());
    await vi.waitFor(() => expect(session.getState()).toBe('listening'));
    await session.onMicFrame(Int16Array.from([5, 6]));
    const chunks = last.ws!.sent.filter((m) => 'user_audio_chunk' in m);
    expect(chunks).toHaveLength(2);
    expect(Buffer.from(chunks[0]!['user_audio_chunk'] as string, 'base64').byteLength).toBe(8);
  });

  test('a turn: words → chat, reply text → chat, audio → surface, tts_end on the final chunk', async () => {
    const { deps, events, binary, timeline, last } = makeDeps();
    const session = new ElevenLabsAgentSession(makeInit(), deps);
    const ws = await open(session, last);
    ws.serverSend(transcript('what time is it'));
    ws.serverSend(response('Ten past two.'));
    ws.serverSend(audioChunk(480));
    expect(session.getState()).toBe('speaking');
    ws.serverSend(audioChunk(480));
    ws.serverSend(complete);
    expect(binary.map((b) => b.length)).toEqual([480, 480]);
    expect(events.filter((e) => e.type === 'audio.tts_end')).toHaveLength(1);
    expect(session.getState()).toBe('listening');
    // Written once it has played out.
    await vi.waitFor(() => expect(timeline.log.at(-1)).toMatch(/^reply:/));
    expect(timeline.log).toEqual([
      'user:chat-1:what time is it',
      'begin:chat-1',
      'delta:Ten past two.',
      'reply:chat-1:Ten past two.',
    ]);
    expect(events).toContainEqual({
      type: 'audio.transcript_final',
      sessionId: 'sess-1',
      text: 'what time is it',
    });
  });

  test('a reply stays open until agent_response_complete, whatever the text and gaps', async () => {
    const { deps, events, last } = makeDeps();
    const session = new ElevenLabsAgentSession(makeInit(), deps);
    const ws = await open(session, last);
    ws.serverSend(transcript('tell me a story'));
    ws.serverSend(audioChunk(480));
    ws.serverSend(response('Once upon a time.'));
    await new Promise((r) => setTimeout(r, 100));
    ws.serverSend(audioChunk(480));
    await new Promise((r) => setTimeout(r, 50));
    expect(events.filter((e) => e.type === 'audio.tts_end')).toHaveLength(0);
    expect(session.getState()).toBe('speaking');
    ws.serverSend(complete);
    await vi.waitFor(() =>
      expect(events.filter((e) => e.type === 'audio.tts_end')).toEqual([
        { type: 'audio.tts_end', sessionId: 'sess-1' },
      ]),
    );
    expect(session.getState()).toBe('listening');
  });

  test('agent_response_complete ends the reply at once', async () => {
    const { deps, events, last } = makeDeps();
    const session = new ElevenLabsAgentSession(makeInit(), deps);
    const ws = await open(session, last);
    ws.serverSend(transcript('hi'));
    ws.serverSend(audioChunk(480));
    ws.serverSend({
      type: 'agent_response_complete',
      agent_response_complete_event: { event_id: 1 },
    });
    expect(events.filter((e) => e.type === 'audio.tts_end')).toHaveLength(1);
    expect(session.getState()).toBe('listening');
  });

  test('expressive audio tags are kept out of the chat', async () => {
    const { deps, timeline, last } = makeDeps();
    const session = new ElevenLabsAgentSession(makeInit(), deps);
    const ws = await open(session, last);
    ws.serverSend(transcript('say banana'));
    ws.serverSend(response('[happy] Banana! [laughs]'));
    ws.serverSend(audioChunk(480));
    ws.serverSend(complete);
    await vi.waitFor(() => expect(timeline.log).toContain('reply:chat-1:Banana!'));
  });

  test('a ping is answered with a pong carrying its event id', async () => {
    const { deps, last } = makeDeps();
    const ws = await open(new ElevenLabsAgentSession(makeInit(), deps), last);
    ws.serverSend({ type: 'ping', ping_event: { event_id: 7, ping_ms: 0 } });
    expect(ws.ofType('pong')).toEqual([{ type: 'pong', event_id: 7 }]);
  });

  test('an interruption mid-reply stops the surface as a barge-in', async () => {
    const { deps, events, last } = makeDeps();
    const session = new ElevenLabsAgentSession(makeInit(), deps);
    const ws = await open(session, last);
    ws.serverSend(transcript('hello'));
    ws.serverSend(audioChunk(480));
    ws.serverSend({ type: 'interruption', interruption_event: { event_id: 2 } });
    expect(events.some((e) => e.type === 'audio.barge_in')).toBe(true);
    expect(events).toContainEqual({ type: 'audio.tts_end', sessionId: 'sess-1', bargedIn: true });
    expect(session.getState()).toBe('listening');
  });

  test('an interruption keeps only what was heard of the reply in the chat', async () => {
    const { deps, timeline, last } = makeDeps();
    const session = new ElevenLabsAgentSession(makeInit(), deps);
    const ws = await open(session, last);
    ws.serverSend(transcript('tell me a story'));
    ws.serverSend(response('Once upon a time there was a very long story indeed.'));
    // Two seconds of audio, all sent at once; the user cuts in after a fraction of it.
    ws.serverSend(audioChunk(48_000));
    await new Promise((r) => setTimeout(r, 600));
    ws.serverSend({ type: 'interruption', interruption_event: { event_id: 2 } });
    const written = timeline.log.filter((l) => l.startsWith('reply:'));
    expect(written).toHaveLength(1);
    expect(written[0]!).toMatch(/^reply:chat-1:Once upon/);
    expect(written[0]!.length).toBeLessThan(
      'reply:chat-1:Once upon a time there was a very long story indeed.'.length,
    );
  });

  test('pass_to_agent answers "received" at once', async () => {
    const { deps, passed, last } = makeDeps();
    const session = new ElevenLabsAgentSession(makeInit(), deps);
    const ws = await open(session, last);
    ws.serverSend(toolCall(PASS_TO_AGENT_TOOL_NAME, { request: 'trains to Bath' }));
    await vi.waitFor(() => expect(ws.ofType('client_tool_result')).toHaveLength(1));
    expect(passed).toEqual([{ sessionId: 'sess-1', chatId: 'chat-1', request: 'trains to Bath' }]);
    expect(ws.ofType('client_tool_result')[0]).toEqual({
      type: 'client_tool_result',
      tool_call_id: 'call-1',
      result: 'received',
      is_error: false,
    });
    expect(session.engineCosting().backend).toBe('elevenlabs');
  });

  test("the agent's answer is pushed as a user_message once the agent is quiet", async () => {
    const { deps, last } = makeDeps();
    const session = new ElevenLabsAgentSession(makeInit(), deps);
    const ws = await open(session, last);
    ws.serverSend(transcript('trains please'));
    ws.serverSend(response('Passing it on.'));
    ws.serverSend(audioChunk(480));
    session.pushMessage("Answer from the chat's agent: 14:05", { handoffSettled: true });
    expect(ws.ofType('user_message')).toHaveLength(0);
    ws.serverSend(audioChunk(480));
    ws.serverSend(complete);
    expect(ws.ofType('user_message')).toEqual([
      { type: 'user_message', text: "Answer from the chat's agent: 14:05" },
    ]);
  });

  test('a request that could not be passed on is said to the agent and on the call bar', async () => {
    const { link } = fakeVoiceAgentLink({
      passToAgent: () => {
        throw new Error('chat is gone');
      },
    });
    const { deps, events, last } = makeDeps({ link });
    const ws = await open(new ElevenLabsAgentSession(makeInit(), deps), last);
    ws.serverSend(toolCall(PASS_TO_AGENT_TOOL_NAME, { request: 'x' }));
    await vi.waitFor(() => expect(ws.ofType('client_tool_result')).toHaveLength(1));
    expect(String(ws.ofType('client_tool_result')[0]!['result'])).toContain(
      'Not passed on: chat is gone',
    );
    expect(events.some((e) => e.type === 'audio.error' && /chat is gone/.test(e.message))).toBe(
      true,
    );
  });

  test('look_back answers at once from the host', async () => {
    const { deps, last } = makeDeps();
    const ws = await open(new ElevenLabsAgentSession(makeInit(), deps), last);
    ws.serverSend(toolCall(LOOK_BACK_TOOL_NAME, { query: 'dentist' }, 'call-9'));
    await vi.waitFor(() => expect(ws.ofType('client_tool_result')).toHaveLength(1));
    expect(ws.ofType('client_tool_result')[0]).toEqual({
      type: 'client_tool_result',
      tool_call_id: 'call-9',
      result: 'found in chat-1: dentist on Tuesday',
      is_error: false,
    });
  });

  test('an unknown tool is answered as an error and reported', async () => {
    const { deps, events, last } = makeDeps();
    const ws = await open(new ElevenLabsAgentSession(makeInit(), deps), last);
    ws.serverSend(toolCall('mystery', {}));
    expect(ws.ofType('client_tool_result')[0]).toMatchObject({ is_error: true });
    expect(events.some((e) => e.type === 'audio.error')).toBe(true);
  });

  test('noise ("...") is not a turn, a bubble, or answered', async () => {
    const { deps, events, last } = makeDeps();
    const timeline = deps.timeline as unknown as FakeTimeline;
    const session = new ElevenLabsAgentSession(makeInit(), deps);
    const ws = await open(session, last);
    ws.serverSend(transcript('...'));
    ws.serverSend(response("I'm still here..."));
    ws.serverSend(audioChunk(240));
    expect(session.stats().turns).toBe(0);
    expect(timeline.log).toEqual([]);
    expect(events.some((e) => e.type === 'audio.transcript_final')).toBe(false);
    expect(events.some((e) => e.type === 'audio.tts_chunk')).toBe(false);
    ws.serverSend(transcript('hello there'));
    expect(session.stats().turns).toBe(1);
  });

  test('a catch-up goes in as a contextual_update, which asks for no reply', async () => {
    let write!: (text: string) => void;
    const { link } = fakeVoiceAgentLink({
      startContext: () => ({
        text: FAKE_START_CONTEXT,
        catchUp: new Promise<string>((r) => (write = r)),
      }),
    });
    const { deps, last } = makeDeps({ link });
    const ws = await open(new ElevenLabsAgentSession(makeInit(), deps), last);
    write('The plan is done.');
    await vi.waitFor(() => expect(ws.ofType('contextual_update')).toHaveLength(1));
    expect(String(ws.ofType('contextual_update')[0]!['text'])).toContain('The plan is done.');
  });

  test('the provider closing the socket is fatal', async () => {
    const { deps, events, onFatal, last } = makeDeps();
    const ws = await open(new ElevenLabsAgentSession(makeInit(), deps), last);
    ws.emit('close', 1011, Buffer.from('boom'));
    expect(onFatal).toHaveBeenCalledOnce();
    expect((events.find((e) => e.type === 'audio.error') as { message: string }).message).toContain(
      '1011: boom',
    );
  });

  test('speak is refused loudly', async () => {
    const { deps, events, last } = makeDeps();
    const session = new ElevenLabsAgentSession(makeInit(), deps);
    await open(session, last);
    await session.speak();
    expect(events.some((e) => e.type === 'audio.error')).toBe(true);
  });
});

describe('ElevenLabsAgentSession — hands-free address gating', () => {
  const handsFree = (): Partial<SessionInit> => ({ mode: 'hands-free' as AudioSessionMode });

  test('an unaddressed transcript is heard-not-sent and the agent’s reply to it is dropped', async () => {
    const { deps, events, binary, timeline, last } = makeDeps();
    const session = new ElevenLabsAgentSession(makeInit(handsFree()), deps);
    const ws = await open(session, last);
    ws.serverSend(transcript('pass me the salt'));
    ws.serverSend(response('Sure, here you go'));
    ws.serverSend(audioChunk(480));
    ws.serverSend(complete);
    expect(events).toContainEqual({
      type: 'audio.transcript_final',
      sessionId: 'sess-1',
      text: 'pass me the salt',
      addressed: false,
    });
    expect(binary).toHaveLength(0);
    expect(timeline.log).toEqual([]);
    expect(session.stats().turns).toBe(0);
  });

  test('an addressed transcript is a turn and its reply plays; suppression ends with the next turn', async () => {
    const { deps, binary, timeline, last } = makeDeps();
    const session = new ElevenLabsAgentSession(makeInit(handsFree()), deps);
    const ws = await open(session, last);
    ws.serverSend(transcript('pass me the salt'));
    ws.serverSend(audioChunk(480));
    ws.serverSend(complete);
    expect(binary).toHaveLength(0);
    ws.serverSend(transcript('Patch what time is it'));
    ws.serverSend(response('Two.'));
    ws.serverSend(audioChunk(480));
    ws.serverSend(complete);
    expect(binary).toHaveLength(1);
    expect(timeline.log[0]).toBe('user:chat-1:Patch what time is it');
    expect(session.stats().turns).toBe(1);
  });

  test('in a call everything is addressed', async () => {
    const { deps, events, last } = makeDeps();
    const ws = await open(new ElevenLabsAgentSession(makeInit(), deps), last);
    ws.serverSend(transcript('pass me the salt'));
    const f = events.find((e) => e.type === 'audio.transcript_final') as Record<string, unknown>;
    expect(f['addressed']).toBeUndefined();
  });
});
