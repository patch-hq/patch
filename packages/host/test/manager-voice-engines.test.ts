// spec/07 § A call to the Manager — each hosted engine on a Manager call: it
// declares the manager tools in place of pass_to_agent, runs them against
// the host, and a chat's reply reaches the voice. Every provider socket is an
// in-memory fake; nothing here spends.

import { describe, test, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import type { WebSocket as WsSocket } from 'ws';
import { DEFAULT_VOICE_INSTRUCTIONS } from '@patch/wire';
import { fakeVoiceAgentLink, emptyToolbox } from './helpers/fakeVoiceAgentLink.js';
import {
  LOOK_BACK_TOOL_NAME,
  PASS_TO_AGENT_TOOL_NAME,
  SEND_TO_CHAT_TOOL_NAME,
} from '../src/audio/voiceAgent.js';
import {
  GeminiLiveSession,
  MANAGER_FALSE_CLAIM_CORRECTION,
  type GeminiLiveDeps,
} from '../src/audio/gemini-live.js';
import {
  OpenAIRealtimeSession,
  type OpenAIRealtimeDeps,
  type OpenAIWsCtor,
} from '../src/audio/openai-realtime.js';
import {
  ElevenLabsAgentSession,
  type ElevenLabsAgentDeps,
  type ElevenLabsWsCtor,
} from '../src/audio/elevenlabs-agent.js';
import { MANAGER_QUICK_TOOLS, type ManagerVoiceTools } from '../src/audio/managerVoice.js';
import { MANAGER_CHAT_ID } from '../src/audio/chatLookup.js';
import {
  CHAT_STATUS_TOOL_NAME,
  FIND_CHATS_TOOL_NAME,
  type VoiceAgentLink,
} from '../src/audio/voiceAgent.js';
import type { SessionInit } from '../src/audio/session.js';
import type { AudioEvent } from '@patch/wire/audio';

const logger = pino({ level: 'silent' });

const init = (overrides: Partial<SessionInit> = {}): SessionInit => ({
  sessionId: 'sess-m',
  accountId: 'acct',
  surfaceId: 'surf',
  surfaceKind: 'mobile',
  chatId: MANAGER_CHAT_ID,
  role: 'voice-call',
  surfaceHasAec: true,
  ...overrides,
});

const timeline = () => ({
  log: [] as string[],
  userSaid(chatId: string, text: string) {
    this.log.push(`user:${chatId}:${text}`);
  },
  beginReply(chatId: string) {
    let text = '';
    let logged = '';
    return {
      set: (t: string) => {
        text = t;
      },
      finish: () => {
        if (text === logged) return;
        logged = text;
        this.log.push(`reply:${chatId}:${text}`);
      },
    };
  },
});

/** A manager with no quick tools wired; the send path is the shared link's. */
function fakeManager() {
  const manager: ManagerVoiceTools = {
    quick: vi.fn(async () => 'done'),
  };
  return { manager };
}

/** A link whose send is answered once, and whose reply the test releases. */
function fakeSend(opts: { reply?: string; miss?: string; fails?: Error } = {}) {
  let release!: (reply: string) => void;
  const { link, passed } = fakeVoiceAgentLink({
    sendToChat: async () => {
      if (opts.fails) throw opts.fails;
      if (opts.miss) return { ok: false, message: opts.miss };
      return {
        ok: true,
        name: 'Garden planning',
        reply: new Promise<string>((r) => (release = r)),
      };
    },
  });
  return { link, passed, release: (r: string) => release(r) };
}

// ---------------------------------------------------------------------------

class FakeGeminiWs extends EventEmitter {
  sent: string[] = [];
  constructor(public readonly url: string) {
    super();
  }
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {}
  json(): Array<Record<string, any>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, any>);
  }
  serverSend(m: unknown): void {
    this.emit('message', JSON.stringify(m), false);
  }
  clientTurns(): string[] {
    return this.json().flatMap((f) =>
      f['clientContent'] ? [f['clientContent'].turns[0].parts[0].text as string] : [],
    );
  }
  toolResponses(): Array<Record<string, any>> {
    return this.json().flatMap((f) =>
      f['toolResponse'] ? (f['toolResponse'].functionResponses as Array<Record<string, any>>) : [],
    );
  }
}

async function openGemini(
  manager: ManagerVoiceTools | undefined,
  chatId = MANAGER_CHAT_ID,
  given?: VoiceAgentLink,
) {
  const last: { ws?: FakeGeminiWs } = {};
  const events: AudioEvent[] = [];
  const fake = fakeVoiceAgentLink();
  const link = given ?? fake.link;
  const passed = fake.passed;
  const deps: GeminiLiveDeps = {
    logger,
    sendAudio: (e) => events.push(e),
    sendBinary: () => {},
    link,
    toolbox: emptyToolbox(),
    instructions: DEFAULT_VOICE_INSTRUCTIONS,
    apiKey: 'k',
    timeline: timeline(),
    wsCtor: function (this: unknown, url: string) {
      last.ws = new FakeGeminiWs(url);
      return last.ws;
    } as unknown as new (url: string) => WsSocket,
    ...(manager ? { manager } : {}),
  };
  const session = new GeminiLiveSession(init({ chatId }), deps);
  session.onSessionStart();
  await vi.waitFor(() => expect(last.ws).toBeDefined());
  const ws = last.ws!;
  ws.emit('open');
  await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
  ws.serverSend({ setupComplete: {} });
  await vi.waitFor(() => expect(session.getState()).toBe('listening'));
  return { session, ws, events, passed, link };
}

describe('Gemini Live on a Manager call', () => {
  test('declares the manager tools and the Manager instruction, not pass_to_agent', async () => {
    const { manager } = fakeManager();
    const { ws } = await openGemini(manager);
    const setup = ws.json()[0]!['setup'];
    const names = setup.tools[0].functionDeclarations.map((d: { name: string }) => d.name);
    expect(names).toEqual([
      ...MANAGER_QUICK_TOOLS.map((t) => t.name),
      LOOK_BACK_TOOL_NAME,
      FIND_CHATS_TOOL_NAME,
      CHAT_STATUS_TOOL_NAME,
      SEND_TO_CHAT_TOOL_NAME,
      'end_call',
    ]);
    const text = setup.systemInstruction.parts[0].text as string;
    expect(text).toContain('You are the Manager');
    expect(text).not.toContain(PASS_TO_AGENT_TOOL_NAME);
  });

  test('a non-Manager session keeps the voice agent tools', async () => {
    const { ws } = await openGemini(undefined, 'chat-1');
    const names = ws
      .json()[0]!
      ['setup'].tools[0].functionDeclarations.map((d: { name: string }) => d.name);
    expect(names).toEqual([
      PASS_TO_AGENT_TOOL_NAME,
      'check_status',
      LOOK_BACK_TOOL_NAME,
      FIND_CHATS_TOOL_NAME,
      CHAT_STATUS_TOOL_NAME,
      SEND_TO_CHAT_TOOL_NAME,
      'end_call',
      'switch_chat',
    ]);
  });

  test('send_to_chat answers received at once; the chat’s reply arrives later as a message', async () => {
    const { manager } = fakeManager();
    const { link, release } = fakeSend();
    const { ws, passed } = await openGemini(manager, MANAGER_CHAT_ID, link);
    ws.serverSend({
      toolCall: {
        functionCalls: [
          {
            id: 's1',
            name: SEND_TO_CHAT_TOOL_NAME,
            args: { chat: 'garden', message: 'use ferns' },
          },
        ],
      },
    });
    await vi.waitFor(() => expect(ws.toolResponses()).toHaveLength(1));
    expect(link.sendToChat).toHaveBeenCalledWith({
      chatId: MANAGER_CHAT_ID,
      chat: 'garden',
      message: 'use ferns',
    });
    // The Manager's own agent is not in the loop.
    expect(passed).toHaveLength(0);
    expect(ws.toolResponses()[0]).toMatchObject({ id: 's1', name: SEND_TO_CHAT_TOOL_NAME });
    expect(ws.toolResponses()[0]!['response'].result).toBe('received');
    release('Ferns are in the plan.');
    await vi.waitFor(() => expect(ws.clientTurns().length).toBe(1));
    expect(ws.clientTurns()[0]).toContain('Chat: Garden planning');
    expect(ws.clientTurns()[0]).toContain('Ferns are in the plan.');
  });

  test('an ordinary call sends to a chat the same way, and the reply is pushed back once', async () => {
    const { link, release } = fakeSend();
    const { ws } = await openGemini(undefined, 'chat-1', link);
    ws.serverSend({
      toolCall: {
        functionCalls: [
          { id: 's5', name: SEND_TO_CHAT_TOOL_NAME, args: { chat: 'garden', message: 'status?' } },
        ],
      },
    });
    await vi.waitFor(() => expect(ws.toolResponses()).toHaveLength(1));
    expect(ws.toolResponses()[0]!['response'].result).toBe('received');
    expect(link.sendToChat).toHaveBeenCalledWith({
      chatId: 'chat-1',
      chat: 'garden',
      message: 'status?',
    });
    release('Nearly done.');
    await vi.waitFor(() => expect(ws.clientTurns().length).toBe(1));
    expect(ws.clientTurns()[0]).toContain('Nearly done.');
    await new Promise((r) => setTimeout(r, 50));
    expect(ws.clientTurns().length).toBe(1);
  });

  test('a receipt is not pushed as an answer', async () => {
    const { link, release } = fakeSend();
    const { ws } = await openGemini(undefined, 'chat-1', link);
    ws.serverSend({
      toolCall: {
        functionCalls: [
          { id: 's6', name: SEND_TO_CHAT_TOOL_NAME, args: { chat: 'garden', message: 'x' } },
        ],
      },
    });
    await vi.waitFor(() => expect(ws.toolResponses()).toHaveLength(1));
    release('');
    await new Promise((r) => setTimeout(r, 50));
    expect(ws.clientTurns()).toEqual([]);
  });

  test('a name that is not one chat comes back to the voice to ask, with no error raised', async () => {
    const { manager } = fakeManager();
    const { link } = fakeSend({ miss: 'Several chats match "bus": "A", "B".' });
    const { ws, events } = await openGemini(manager, MANAGER_CHAT_ID, link);
    ws.serverSend({
      toolCall: {
        functionCalls: [
          { id: 's3', name: SEND_TO_CHAT_TOOL_NAME, args: { chat: 'bus', message: 'x' } },
        ],
      },
    });
    await vi.waitFor(() => expect(ws.toolResponses()).toHaveLength(1));
    expect(ws.toolResponses()[0]!['response'].result).toContain('Several chats match');
    expect(events.some((e) => e.type === 'audio.error')).toBe(false);
  });

  test('a message that did not go in is an audible error', async () => {
    const { manager } = fakeManager();
    const { link } = fakeSend({ fails: new Error('host offline') });
    const { ws, events } = await openGemini(manager, MANAGER_CHAT_ID, link);
    ws.serverSend({
      toolCall: {
        functionCalls: [
          { id: 's4', name: SEND_TO_CHAT_TOOL_NAME, args: { chat: 'garden', message: 'x' } },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(
        events.some(
          (e) => e.type === 'audio.error' && /send_to_chat failed.*host offline/.test(e.message),
        ),
      ).toBe(true),
    );
  });

  test('find_chats and chat_status answer at once', async () => {
    const { manager } = fakeManager();
    const { ws, link } = await openGemini(manager);
    ws.serverSend({
      toolCall: {
        functionCalls: [
          { id: 'f1', name: FIND_CHATS_TOOL_NAME, args: { query: 'garden' } },
          { id: 'f2', name: CHAT_STATUS_TOOL_NAME, args: { chat: 'garden' } },
        ],
      },
    });
    await vi.waitFor(() => expect(ws.toolResponses()).toHaveLength(2));
    const byId = Object.fromEntries(ws.toolResponses().map((r) => [r['id'], r['response']]));
    expect(byId['f1'].result).toContain('Garden planning');
    expect(byId['f2'].result).toContain('drafting');
    // The shared lookup, on the call's own chat (the Manager's).
    expect(link.findChats).toHaveBeenCalledWith(MANAGER_CHAT_ID, 'garden');
    expect(link.chatStatus).toHaveBeenCalledWith(MANAGER_CHAT_ID, 'garden');
  });

  test('claiming a send that never happened is corrected with the Manager wording', async () => {
    const { manager } = fakeManager();
    const { ws } = await openGemini(manager);
    ws.serverSend({ serverContent: { inputTranscription: { text: 'tell garden to use ferns' } } });
    ws.serverSend({ serverContent: { outputTranscription: { text: "I've sent that to them." } } });
    ws.serverSend({ serverContent: { turnComplete: true } });
    await vi.waitFor(() => expect(ws.clientTurns()).toContain(MANAGER_FALSE_CLAIM_CORRECTION), {
      timeout: 2000,
    });
  });
});

// ---------------------------------------------------------------------------

class FakeOpenAIWs extends EventEmitter {
  sent: Array<Record<string, any>> = [];
  constructor(public readonly url: string) {
    super();
  }
  send(d: string): void {
    this.sent.push(JSON.parse(d) as Record<string, any>);
  }
  close(): void {}
  serverSend(ev: unknown): void {
    this.emit('message', JSON.stringify(ev));
  }
  ofType(t: string): Array<Record<string, any>> {
    return this.sent.filter((m) => m['type'] === t);
  }
}

async function openOpenAI(manager: ManagerVoiceTools, given?: VoiceAgentLink) {
  const last: { ws?: FakeOpenAIWs } = {};
  const events: AudioEvent[] = [];
  const fake = fakeVoiceAgentLink();
  const link = given ?? fake.link;
  const passed = fake.passed;
  const deps: OpenAIRealtimeDeps = {
    logger,
    sendAudio: (e) => events.push(e),
    sendBinary: () => {},
    link,
    toolbox: emptyToolbox(),
    instructions: DEFAULT_VOICE_INSTRUCTIONS,
    apiKey: 'k',
    model: 'gpt-realtime-2.1-mini',
    timeline: timeline(),
    wsCtor: function (this: unknown, url: string) {
      last.ws = new FakeOpenAIWs(url);
      return last.ws;
    } as unknown as OpenAIWsCtor,
    manager,
  };
  const session = new OpenAIRealtimeSession(init(), deps);
  session.onSessionStart();
  await vi.waitFor(() => expect(last.ws).toBeDefined());
  const ws = last.ws!;
  ws.emit('open');
  await vi.waitFor(() => expect(ws.ofType('session.update')).toHaveLength(1));
  ws.serverSend({ type: 'session.updated' });
  await vi.waitFor(() => expect(session.getState()).toBe('listening'));
  return { session, ws, events, passed };
}

describe('OpenAI Realtime on a Manager call', () => {
  test('declares the manager tools, and send_to_chat answers received at once', async () => {
    const { manager } = fakeManager();
    const { link, passed } = fakeSend();
    const { ws } = await openOpenAI(manager, link);
    const session = ws.ofType('session.update')[0]!['session'];
    expect(session.tools.map((t: { name: string }) => t.name)).toEqual([
      ...MANAGER_QUICK_TOOLS.map((t) => t.name),
      LOOK_BACK_TOOL_NAME,
      FIND_CHATS_TOOL_NAME,
      CHAT_STATUS_TOOL_NAME,
      SEND_TO_CHAT_TOOL_NAME,
      'end_call',
    ]);
    expect(session.instructions).toContain('You are the Manager');
    ws.serverSend({
      type: 'response.function_call_arguments.done',
      name: SEND_TO_CHAT_TOOL_NAME,
      call_id: 'o1',
      arguments: JSON.stringify({ chat: 'garden', message: 'use ferns' }),
    });
    await vi.waitFor(() => expect(ws.ofType('conversation.item.create')).toHaveLength(1));
    const item = ws.ofType('conversation.item.create')[0]!['item'];
    expect(item).toMatchObject({ type: 'function_call_output', call_id: 'o1' });
    expect(JSON.parse(item.output).result).toBe('received');
    expect(link.sendToChat).toHaveBeenCalledWith({
      chatId: MANAGER_CHAT_ID,
      chat: 'garden',
      message: 'use ferns',
    });
    expect(passed).toHaveLength(0);
  });

  test('a lookup miss is handed back to the voice without an error', async () => {
    const { manager } = fakeManager();
    const { link } = fakeSend({ miss: 'No chat matches "x".' });
    const { ws, events } = await openOpenAI(manager, link);
    ws.serverSend({
      type: 'response.function_call_arguments.done',
      name: SEND_TO_CHAT_TOOL_NAME,
      call_id: 'o2',
      arguments: JSON.stringify({ chat: 'x', message: 'y' }),
    });
    await vi.waitFor(() => expect(ws.ofType('conversation.item.create')).toHaveLength(1));
    const out = JSON.parse(ws.ofType('conversation.item.create')[0]!['item'].output);
    expect(out.result).toBe('No chat matches "x".');
    expect(events.some((e) => e.type === 'audio.error')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

class FakeElevenWs extends EventEmitter {
  sent: Array<Record<string, any>> = [];
  constructor(public readonly url: string) {
    super();
  }
  send(d: string): void {
    this.sent.push(JSON.parse(d) as Record<string, any>);
  }
  close(): void {}
  serverSend(ev: unknown): void {
    this.emit('message', JSON.stringify(ev));
  }
  ofType(t: string): Array<Record<string, any>> {
    return this.sent.filter((m) => m['type'] === t);
  }
}

describe('ElevenLabs Agents on a Manager call', () => {
  test('provisions the manager tools, and send_to_chat answers received at once', async () => {
    const { manager } = fakeManager();
    const sendLink = fakeSend().link;
    const rest: Array<{ path: string; body: any }> = [];
    let n = 0;
    const fetchImpl = vi.fn(async (url: string, req: RequestInit) => {
      const u = new URL(url);
      const path = u.pathname + u.search;
      rest.push({ path, body: req.body ? JSON.parse(req.body as string) : undefined });
      if (path === '/v1/convai/tools') return Response.json({ id: `tool-${++n}` });
      if (path === '/v1/convai/agents/create') return Response.json({ agent_id: 'agent-1' });
      if (path.startsWith('/v1/convai/conversation/get-signed-url'))
        return Response.json({ signed_url: 'wss://signed.example/c' });
      return Response.json({});
    });
    const last: { ws?: FakeElevenWs } = {};
    const deps: ElevenLabsAgentDeps = {
      logger,
      sendAudio: () => {},
      sendBinary: () => {},
      link: sendLink,
      toolbox: emptyToolbox(),
      instructions: DEFAULT_VOICE_INSTRUCTIONS,
      apiKey: 'k',
      llm: 'claude-haiku-4-5',
      timeline: timeline(),
      wsCtor: function (this: unknown, url: string) {
        last.ws = new FakeElevenWs(url);
        return last.ws;
      } as unknown as ElevenLabsWsCtor,
      fetchImpl: fetchImpl as unknown as ElevenLabsAgentDeps['fetchImpl'],
      manager,
    };
    const session = new ElevenLabsAgentSession(init(), deps);
    session.onSessionStart();
    await vi.waitFor(() => expect(last.ws).toBeDefined());
    const ws = last.ws!;
    ws.emit('open');
    await vi.waitFor(() =>
      expect(ws.ofType('conversation_initiation_client_data')).toHaveLength(1),
    );
    ws.serverSend({
      type: 'conversation_initiation_metadata',
      conversation_initiation_metadata_event: {
        conversation_id: 'conv-1',
        agent_output_audio_format: 'pcm_24000',
        user_input_audio_format: 'pcm_16000',
      },
    });
    await vi.waitFor(() => expect(session.getState()).toBe('listening'));
    const tools = rest.filter((r) => r.path === '/v1/convai/tools');
    expect(tools.map((t) => t.body.tool_config.name)).toEqual([
      ...MANAGER_QUICK_TOOLS.map((t) => t.name),
      LOOK_BACK_TOOL_NAME,
      FIND_CHATS_TOOL_NAME,
      CHAT_STATUS_TOOL_NAME,
      SEND_TO_CHAT_TOOL_NAME,
      'end_call',
    ]);
    const send = tools.find((t) => t.body.tool_config.name === SEND_TO_CHAT_TOOL_NAME)!;
    expect(Object.keys(send.body.tool_config.parameters.properties)).toEqual(['chat', 'message']);
    const agent = rest.find((r) => r.path === '/v1/convai/agents/create')!.body;
    expect(agent.conversation_config.agent.prompt.prompt).toContain('You are the Manager');
    ws.serverSend({
      type: 'client_tool_call',
      client_tool_call: {
        tool_name: SEND_TO_CHAT_TOOL_NAME,
        tool_call_id: 'e1',
        parameters: { chat: 'garden', message: 'use ferns' },
      },
    });
    await vi.waitFor(() => expect(ws.ofType('client_tool_result')).toHaveLength(1));
    const result = ws.ofType('client_tool_result')[0]!;
    expect(result['tool_call_id']).toBe('e1');
    expect(result['is_error']).toBe(false);
    expect(result['result']).toBe('received');
    expect(sendLink.sendToChat).toHaveBeenCalledWith({
      chatId: MANAGER_CHAT_ID,
      chat: 'garden',
      message: 'use ferns',
    });
    await session.close();
  });
});
