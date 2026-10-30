// ElevenLabs Agents session unit tests. Both the REST API and the conversation
// socket are in-memory fakes — ElevenLabs is a paid API and nothing here may reach it.

import { describe, test, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import {
  ElevenLabsAgentSession,
  DEFAULT_ELEVENLABS_AGENT_LLMS,
  elevenLabsAgentLlmFor,
  type ElevenLabsAgentDeps,
  type ElevenLabsWsCtor,
} from '../src/audio/elevenlabs-agent.js';
import { DISPATCH_TOOL_NAME } from '../src/audio/gemini-live.js';
import { LOOK_BACK_TOOL_NAME } from '../src/audio/chatBriefing.js';
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
  const submitUserTurn = vi.fn(async () => 'next train is 14:05');
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
    submitUserTurn: submitUserTurn as unknown as ElevenLabsAgentDeps['submitUserTurn'],
    apiKey: 'e-key',
    llm: 'claude-haiku-4-5',
    wsCtor,
    fetchImpl: fetchImpl as unknown as ElevenLabsAgentDeps['fetchImpl'],
    onFatal,
    timeline,
    lookBack: () => 'found: dentist on Tuesday',
    ...overrides,
  };
  return { deps, events, binary, rest, last, submitUserTurn, onFatal, timeline };
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

const audioChunk = (samples: number, isFinal = false) => ({
  type: 'audio',
  audio_event: {
    audio_base_64: Buffer.from(new Int16Array(samples).fill(1000).buffer).toString('base64'),
    event_id: 1,
    is_final: isFinal,
  },
});
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

describe('front LLM per layer', () => {
  test('light and direct run Haiku; heavy runs Sonnet; hosts can override', () => {
    expect(elevenLabsAgentLlmFor('light')).toBe(DEFAULT_ELEVENLABS_AGENT_LLMS.light);
    expect(elevenLabsAgentLlmFor('direct')).toBe(DEFAULT_ELEVENLABS_AGENT_LLMS.light);
    expect(elevenLabsAgentLlmFor('heavy')).toBe(DEFAULT_ELEVENLABS_AGENT_LLMS.heavy);
    expect(elevenLabsAgentLlmFor('heavy', { heavy: 'x' })).toBe('x');
    expect(elevenLabsAgentLlmFor('light', { light: 'y' })).toBe('y');
  });
});

describe('ElevenLabsAgentSession — provisioning', () => {
  test('creates both client tools and an agent on the chosen LLM, then dials the signed URL', async () => {
    const { deps, rest, last } = makeDeps({
      getChatContext: () => [{ role: 'user', text: 'we are planning the garden' }],
    });
    const session = new ElevenLabsAgentSession(makeInit(), deps);
    const ws = await open(session, last);
    expect(rest.every((r) => r.key === 'e-key')).toBe(true);
    const tools = rest.filter((r) => r.path === '/v1/convai/tools');
    expect(tools.map((t) => t.body!['tool_config'].name)).toEqual([
      DISPATCH_TOOL_NAME,
      LOOK_BACK_TOOL_NAME,
    ]);
    expect(tools[0]!.body!['tool_config'].type).toBe('client');
    expect(tools[0]!.body!['tool_config'].expects_response).toBe(true);
    const agent = rest.find((r) => r.path === '/v1/convai/agents/create')!.body!;
    expect(agent['conversation_config'].agent.prompt.llm).toBe('claude-haiku-4-5');
    expect(agent['conversation_config'].agent.prompt.tool_ids).toEqual(['tool-1', 'tool-2']);
    expect(agent['conversation_config'].agent.prompt.prompt).toContain('garden');
    expect(agent['conversation_config'].agent.first_message).toBe('');
    expect(agent['conversation_config'].asr.user_input_audio_format).toBe('pcm_16000');
    expect(agent['conversation_config'].tts.agent_output_audio_format).toBe('pcm_24000');
    expect(rest.some((r) => r.path.includes('get-signed-url?agent_id=agent-1'))).toBe(true);
    expect(ws.url).toBe('wss://signed.example/conv?token=t');
  });

  test('handoff never registers no dispatch tool', async () => {
    const { deps, rest, last } = makeDeps({ handoff: 'never', lookBack: undefined });
    await open(new ElevenLabsAgentSession(makeInit(), deps), last);
    expect(rest.filter((r) => r.path === '/v1/convai/tools')).toHaveLength(0);
    expect(
      rest.find((r) => r.path === '/v1/convai/agents/create')!.body!['conversation_config'].agent
        .prompt.tool_ids,
    ).toEqual([]);
  });

  test('close deletes the throwaway agent and its tools', async () => {
    const { deps, rest, last } = makeDeps();
    const session = new ElevenLabsAgentSession(makeInit(), deps);
    const ws = await open(session, last);
    await session.close();
    expect(ws.closed).toBe(true);
    expect(rest.filter((r) => r.method === 'DELETE').map((r) => r.path)).toEqual([
      '/v1/convai/agents/agent-1',
      '/v1/convai/tools/tool-1',
      '/v1/convai/tools/tool-2',
    ]);
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
    ws.serverSend(audioChunk(480, true));
    expect(binary.map((b) => b.length)).toEqual([480, 480]);
    expect(events.filter((e) => e.type === 'audio.tts_end')).toHaveLength(1);
    expect(session.getState()).toBe('listening');
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

  test('dispatch_to_patch goes to the chat and its answer returns as a client_tool_result', async () => {
    const { deps, submitUserTurn, last } = makeDeps();
    const session = new ElevenLabsAgentSession(makeInit(), deps);
    const ws = await open(session, last);
    ws.serverSend(toolCall(DISPATCH_TOOL_NAME, { request: 'trains to Bath' }));
    expect(session.isAwaitingHandoff()).toBe(true);
    await vi.waitFor(() => expect(ws.ofType('client_tool_result')).toHaveLength(1));
    expect(submitUserTurn).toHaveBeenCalledWith({
      chatId: 'chat-1',
      message: 'trains to Bath',
      source: { kind: 'voice-app', surfaceKind: 'mobile', sessionId: 'sess-1' },
      handoff: true,
    });
    expect(ws.ofType('client_tool_result')[0]).toEqual({
      type: 'client_tool_result',
      tool_call_id: 'call-1',
      result: 'next train is 14:05',
      is_error: false,
    });
    expect(session.isAwaitingHandoff()).toBe(false);
    expect(session.engineCosting().backend).toBe('elevenlabs');
  });

  test('a failed dispatch is returned to the agent as an error result, not hidden', async () => {
    const { deps, last } = makeDeps({
      submitUserTurn: vi.fn(async () => {
        throw new Error('chat is busy');
      }) as unknown as ElevenLabsAgentDeps['submitUserTurn'],
    });
    const ws = await open(new ElevenLabsAgentSession(makeInit(), deps), last);
    ws.serverSend(toolCall(DISPATCH_TOOL_NAME, { request: 'x' }));
    await vi.waitFor(() => expect(ws.ofType('client_tool_result')).toHaveLength(1));
    expect(ws.ofType('client_tool_result')[0]).toMatchObject({
      result: 'That failed: chat is busy',
      is_error: true,
    });
  });

  test('look_back answers at once from the host', async () => {
    const { deps, last } = makeDeps();
    const ws = await open(new ElevenLabsAgentSession(makeInit(), deps), last);
    ws.serverSend(toolCall(LOOK_BACK_TOOL_NAME, { query: 'dentist' }, 'call-9'));
    expect(ws.ofType('client_tool_result')[0]).toEqual({
      type: 'client_tool_result',
      tool_call_id: 'call-9',
      result: 'found: dentist on Tuesday',
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

  test('chat messages from elsewhere go in as a contextual_update', async () => {
    const { deps, last } = makeDeps();
    const session = new ElevenLabsAgentSession(makeInit(), deps);
    const ws = await open(session, last);
    session.pushContext('assistant', 'The plan is done.');
    const u = ws.ofType('contextual_update');
    expect(u).toHaveLength(1);
    expect(String(u[0]!['text'])).toContain('The plan is done.');
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
    ws.serverSend(audioChunk(480, true));
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
    ws.serverSend(audioChunk(480, true));
    expect(binary).toHaveLength(0);
    ws.serverSend(transcript('Patch what time is it'));
    ws.serverSend(response('Two.'));
    ws.serverSend(audioChunk(480, true));
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
