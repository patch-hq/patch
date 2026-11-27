// spec/07 § A call to the Manager — each hosted engine on a Manager call: it
// declares the manager tools in place of pass_to_agent, runs them against
// the host, and a chat's reply reaches the voice. Every provider socket is an
// in-memory fake; nothing here spends.

import { describe, test, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import type { WebSocket as WsSocket } from 'ws';
import { DEFAULT_VOICE_INSTRUCTIONS } from '@patch/wire';
import { fakeVoiceAgentLink } from './helpers/fakeVoiceAgentLink.js';
import { LOOK_BACK_TOOL_NAME, PASS_TO_AGENT_TOOL_NAME } from '../src/audio/voiceAgent.js';
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
import {
  CHAT_STATUS_TOOL_NAME,
  FIND_CHATS_TOOL_NAME,
  ManagerChatLookupError,
  MANAGER_CHAT_ID,
  MANAGER_QUICK_TOOLS,
  SEND_TO_CHAT_TOOL_NAME,
  type ManagerSendAccepted,
  type ManagerVoiceTools,
} from '../src/audio/managerVoice.js';
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
    return {
      append: (d: string) => {
        text += d;
      },
      finish: () => {
        this.log.push(`reply:${chatId}:${text}`);
      },
      text: () => text,
    };
  },
});

/** A manager whose send waits for the test to release the chat's reply. */
function fakeManager(
  opts: {
    sendFails?: Error;
    remote?: boolean;
  } = {},
) {
  let release!: (reply: string) => void;
  const sendToChat = vi.fn(
    async (req: {
      chat: string;
      message: string;
      onAccepted?: (i: ManagerSendAccepted) => void;
    }) => {
      if (opts.sendFails) throw opts.sendFails;
      if (opts.remote) {
        req.onAccepted?.({ name: 'Laptop build', replyComing: false });
        return { name: 'Laptop build', reply: null };
      }
      req.onAccepted?.({ name: 'Garden planning', replyComing: true });
      const reply = await new Promise<string>((r) => (release = r));
      return { name: 'Garden planning', reply };
    },
  );
  const manager: ManagerVoiceTools = {
    findChats: vi.fn(async () => '"Garden planning" (id c-garden) — working'),
    chatStatus: vi.fn(async () => 'Where it stands: drafting'),
    sendToChat,
  };
  return { manager, sendToChat, release: (r: string) => release(r) };
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

async function openGemini(manager: ManagerVoiceTools | undefined, chatId = MANAGER_CHAT_ID) {
  const last: { ws?: FakeGeminiWs } = {};
  const events: AudioEvent[] = [];
  const { link, passed } = fakeVoiceAgentLink();
  const deps: GeminiLiveDeps = {
    logger,
    sendAudio: (e) => events.push(e),
    sendBinary: () => {},
    link,
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
  return { session, ws, events, passed };
}

describe('Gemini Live on a Manager call', () => {
  test('declares the manager tools and the Manager instruction, not pass_to_agent', async () => {
    const { manager } = fakeManager();
    const { ws } = await openGemini(manager);
    const setup = ws.json()[0]!['setup'];
    const names = setup.tools[0].functionDeclarations.map((d: { name: string }) => d.name);
    expect(names).toEqual([
      FIND_CHATS_TOOL_NAME,
      CHAT_STATUS_TOOL_NAME,
      SEND_TO_CHAT_TOOL_NAME,
      ...MANAGER_QUICK_TOOLS.map((t) => t.name),
      LOOK_BACK_TOOL_NAME,
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
      'end_call',
      'switch_chat',
    ]);
  });

  test('send_to_chat is answered once the chat has it; its reply arrives later as a message', async () => {
    const { manager, sendToChat, release } = fakeManager();
    const { ws, passed } = await openGemini(manager);
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
    expect(sendToChat).toHaveBeenCalledWith(
      expect.objectContaining({ chat: 'garden', message: 'use ferns' }),
    );
    // The Manager's own agent is not in the loop.
    expect(passed).toHaveLength(0);
    const started = ws.toolResponses()[0]!;
    expect(started).toMatchObject({ id: 's1', name: SEND_TO_CHAT_TOOL_NAME });
    expect(started['response'].result).toBe('started');
    expect(started['response'].note).toContain('"Garden planning" has the message');
    release('Ferns are in the plan.');
    await vi.waitFor(() => expect(ws.clientTurns().length).toBe(1));
    expect(ws.clientTurns()[0]).toContain('The chat "Garden planning" has answered');
    expect(ws.clientTurns()[0]).toContain('Ferns are in the plan.');
  });

  test('a chat on another host: sent, and the voice is told no reply will come into the call', async () => {
    const { manager } = fakeManager({ remote: true });
    const { ws } = await openGemini(manager);
    ws.serverSend({
      toolCall: {
        functionCalls: [
          { id: 's2', name: SEND_TO_CHAT_TOOL_NAME, args: { chat: 'laptop', message: 'go' } },
        ],
      },
    });
    await vi.waitFor(() => expect(ws.toolResponses()).toHaveLength(1));
    expect(ws.toolResponses()[0]!['response'].note).toContain('on another computer');
    await new Promise((r) => setTimeout(r, 20));
    expect(ws.clientTurns()).toEqual([]);
  });

  test('a name that is not one chat comes back to the voice to ask, with no error raised', async () => {
    const { manager } = fakeManager({
      sendFails: new ManagerChatLookupError('Several chats match "bus": "A", "B".'),
    });
    const { ws, events } = await openGemini(manager);
    ws.serverSend({
      toolCall: {
        functionCalls: [
          { id: 's3', name: SEND_TO_CHAT_TOOL_NAME, args: { chat: 'bus', message: 'x' } },
        ],
      },
    });
    await vi.waitFor(() => expect(ws.toolResponses()).toHaveLength(1));
    expect(ws.toolResponses()[0]!['response']).toMatchObject({ result: 'failed' });
    expect(ws.toolResponses()[0]!['response'].note).toContain('Several chats match');
    expect(events.some((e) => e.type === 'audio.error')).toBe(false);
  });

  test('a message that did not go in is an audible error', async () => {
    const { manager } = fakeManager({ sendFails: new Error('host offline') });
    const { ws, events } = await openGemini(manager);
    ws.serverSend({
      toolCall: {
        functionCalls: [
          { id: 's4', name: SEND_TO_CHAT_TOOL_NAME, args: { chat: 'garden', message: 'x' } },
        ],
      },
    });
    await vi.waitFor(() =>
      expect(
        events.some((e) => e.type === 'audio.error' && /not sent.*host offline/.test(e.message)),
      ).toBe(true),
    );
  });

  test('find_chats and chat_status answer at once', async () => {
    const { manager } = fakeManager();
    const { ws } = await openGemini(manager);
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
    expect(manager.findChats).toHaveBeenCalledWith('garden');
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

async function openOpenAI(manager: ManagerVoiceTools) {
  const last: { ws?: FakeOpenAIWs } = {};
  const events: AudioEvent[] = [];
  const { link, passed } = fakeVoiceAgentLink();
  const deps: OpenAIRealtimeDeps = {
    logger,
    sendAudio: (e) => events.push(e),
    sendBinary: () => {},
    link,
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
  test('declares the manager tools, and send_to_chat returns the chat reply as the call output', async () => {
    const { manager, release } = fakeManager();
    const { ws, passed } = await openOpenAI(manager);
    const session = ws.ofType('session.update')[0]!['session'];
    expect(session.tools.map((t: { name: string }) => t.name)).toEqual([
      FIND_CHATS_TOOL_NAME,
      CHAT_STATUS_TOOL_NAME,
      SEND_TO_CHAT_TOOL_NAME,
      ...MANAGER_QUICK_TOOLS.map((t) => t.name),
      LOOK_BACK_TOOL_NAME,
      'end_call',
    ]);
    expect(session.instructions).toContain('You are the Manager');
    ws.serverSend({
      type: 'response.function_call_arguments.done',
      name: SEND_TO_CHAT_TOOL_NAME,
      call_id: 'o1',
      arguments: JSON.stringify({ chat: 'garden', message: 'use ferns' }),
    });
    await vi.waitFor(() => expect(manager.sendToChat).toHaveBeenCalled());
    expect(ws.ofType('conversation.item.create')).toHaveLength(0);
    release('Ferns are in.');
    await vi.waitFor(() => expect(ws.ofType('conversation.item.create')).toHaveLength(1));
    const item = ws.ofType('conversation.item.create')[0]!['item'];
    expect(item).toMatchObject({ type: 'function_call_output', call_id: 'o1' });
    expect(JSON.parse(item.output).result).toBe('"Garden planning" replied: Ferns are in.');
    expect(ws.ofType('response.create')).toHaveLength(1);
    expect(passed).toHaveLength(0);
  });

  test('a lookup miss is handed back to the voice without an error', async () => {
    const { manager } = fakeManager({
      sendFails: new ManagerChatLookupError('No chat matches "x".'),
    });
    const { ws, events } = await openOpenAI(manager);
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
  test('provisions the manager tools, and send_to_chat answers with the chat reply', async () => {
    const { manager, release } = fakeManager();
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
      link: fakeVoiceAgentLink().link,
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
      FIND_CHATS_TOOL_NAME,
      CHAT_STATUS_TOOL_NAME,
      SEND_TO_CHAT_TOOL_NAME,
      ...MANAGER_QUICK_TOOLS.map((t) => t.name),
      LOOK_BACK_TOOL_NAME,
      'end_call',
    ]);
    expect(Object.keys(tools[2]!.body.tool_config.parameters.properties)).toEqual([
      'chat',
      'message',
    ]);
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
    await vi.waitFor(() => expect(manager.sendToChat).toHaveBeenCalled());
    release('Ferns are in.');
    await vi.waitFor(() => expect(ws.ofType('client_tool_result')).toHaveLength(1));
    const result = ws.ofType('client_tool_result')[0]!;
    expect(result['tool_call_id']).toBe('e1');
    expect(result['is_error']).toBe(false);
    expect(result['result']).toContain('"Garden planning" replied: Ferns are in.');
    await session.close();
  });
});
