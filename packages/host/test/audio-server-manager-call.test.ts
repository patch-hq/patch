// Integration: a hosted voice call to the Manager (spec/07 § A call to the
// Manager), end to end on the host — a real audio WSS, the real audio server
// choosing the engine, a real GeminiLiveSession (its provider socket faked),
// the real manager tools, and a reply bridge standing in for the server's
// record of the target chat. Only the chat host is a
// fake: when a message is delivered it plays out the target chat's turn as the
// host's own wire events (the user message carrying the sent localId, running,
// the agent's answer, idle). No request leaves this process.

import { DEFAULT_VOICE_INSTRUCTIONS } from '@patch/wire';
import { fakeVoiceAgentLink } from './helpers/fakeVoiceAgentLink.js';
import { describe, test, expect, afterEach, vi } from 'vitest';
import pino from 'pino';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { WebSocket as WsSocket } from 'ws';
import type { WireEvent } from '@patch/wire';
import {
  startAudioServer,
  type AudioServerHandle,
  type AudioServerOptions,
} from '../src/audio/server.js';
import { createKokoro } from '../src/audio/kokoro.js';
import type { Vad, VadFrameResult } from '../src/audio/vad.js';
import type { WhisperBackend } from '../src/audio/whisper.js';
import { createVoiceReplyBridge } from '../src/audio/replyBridge.js';
import { createManagerVoiceTools } from '../src/audio/managerVoice.js';
import { createChatVoice, type ChatVoiceHost } from '../src/audio/chatVoice.js';
import type { VoiceLedger } from '../src/audio/voiceLedger.js';
import { createChatLookup, MANAGER_CHAT_ID } from '../src/audio/chatLookup.js';
import {
  FIND_CHATS_TOOL_NAME,
  PASS_TO_AGENT_TOOL_NAME,
  SEND_TO_CHAT_TOOL_NAME,
} from '../src/audio/voiceAgent.js';
import {
  encodeAudio,
  decodeAudio,
  DEFAULT_VOICE_CONFIG,
  type AudioEvent,
  type VoiceConfig,
} from '@patch/wire/audio';

const SECRET = 'unit-test-internal-token-aaaaaaaaaa';
const logger = pino({ level: 'silent' });
const until = (fn: () => void): Promise<void> => vi.waitFor(fn, { timeout: 3000, interval: 5 });

function mintToken(sessionId: string, chatId: string): string {
  const claims = {
    accountId: 'a',
    surfaceId: 'surf',
    sessionId,
    chatId,
    exp: Date.now() + 60_000,
    jti: `jti-${Math.random().toString(36).slice(2)}`,
  };
  const b64 = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const sig = createHmac('sha256', SECRET).update(b64).digest().toString('base64url');
  return `${b64}.${sig}`;
}

async function openCall(port: number, sessionId: string, chatId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/audio/${sessionId}`);
  const events: AudioEvent[] = [];
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (!isBinary) events.push(decodeAudio(data));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(
    encodeAudio({
      type: 'audio.session_start',
      sessionId,
      accountId: 'a',
      surfaceId: 'surf',
      surfaceKind: 'mobile',
      chatId,
      role: 'voice-call',
      mode: 'call',
      token: mintToken(sessionId, chatId),
      surfaceHasAec: true,
    }),
  );
  return { ws, events };
}

class FakeGeminiWs extends EventEmitter {
  sent: Array<Record<string, any>> = [];
  constructor(public readonly url: string) {
    super();
  }
  send(data: string): void {
    const msg = JSON.parse(data) as Record<string, any>;
    this.sent.push(msg);
    if (msg['setup']) {
      queueMicrotask(() => this.emit('message', JSON.stringify({ setupComplete: {} }), false));
    }
  }
  close(): void {}
  say(m: unknown): void {
    this.emit('message', JSON.stringify(m), false);
  }
  toolNames(): string[] {
    return this.sent[0]!['setup'].tools[0].functionDeclarations.map(
      (d: { name: string }) => d.name,
    );
  }
  responses(): Array<Record<string, any>> {
    return this.sent.flatMap((f) => (f['toolResponse'] ? f['toolResponse'].functionResponses : []));
  }
  clientTurns(): string[] {
    return this.sent.flatMap((f) =>
      f['clientContent'] ? [f['clientContent'].turns[0].parts[0].text as string] : [],
    );
  }
}

class SilentVad implements Vad {
  async feed(): Promise<VadFrameResult> {
    return { event: null };
  }
  reset(): void {}
  async close(): Promise<void> {}
}

const whisper: WhisperBackend = {
  supportsLivePartials: false,
  async transcribe() {
    return '';
  },
  async transcribeClip() {
    return '';
  },
  async close() {},
} as unknown as WhisperBackend;

describe('audio server — a hosted call to the Manager', () => {
  let server: (AudioServerHandle & { port: number }) | undefined;
  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  function setup(extra: Partial<AudioServerOptions> = {}) {
    const gemini: FakeGeminiWs[] = [];
    const agentTurns: Array<{ chatId: string; message: string }> = [];
    const managerNotes: string[] = [];
    const delivered: Array<{
      callerChatId: string;
      chatId: string;
      message: string;
      localId: string;
    }> = [];
    const bridge = createVoiceReplyBridge();
    let seq = 0;
    const emit = (e: WireEvent): void => bridge.observe(e);
    // The target chat's turn, as the host would emit it.
    const playTurn = (chatId: string, localId: string, answer: string): void => {
      emit({
        type: 'chat.message',
        chatId,
        role: 'user',
        content: 'x',
        seq: ++seq,
        createdAt: 0,
        localId,
      } as WireEvent);
      emit({ type: 'chat.turn_started', chatId, turnId: localId, seq, at: 0 });
      emit({
        type: 'chat.message',
        chatId,
        role: 'assistant',
        content: answer,
        seq: ++seq,
        createdAt: 0,
      } as WireEvent);
      emit({
        type: 'chat.turn_ended',
        chatId,
        turnId: localId,
        seq,
        at: 0,
        outcome: 'completed',
      });
    };
    const lookup = createChatLookup({
      listChats: async () => [
        { chatId: MANAGER_CHAT_ID, name: 'Manager', folder: '/t/manager', status: 'active' },
        {
          chatId: 'c-garden',
          name: 'Garden planning',
          folder: '/p/garden',
          status: 'active',
          activity: 'idle',
          lastUpdated: Date.now(),
        },
      ],
      peekChat: async (chatId) => ({ chatId, lastMessages: [] }),
    });
    const managerVoice = createManagerVoiceTools({
      logger,
      lookup,
      recordNote: (line) => managerNotes.push(line),
    });
    // The shared send, as the host wires it: only the send path of the glue is used here.
    const glue = createChatVoice({
      daemon: {
        recordCallNote: (_chatId: string, line: string) => managerNotes.push(line),
      } as unknown as ChatVoiceHost,
      sessionsOnChat: () => [],
      lookup,
      deliver: async (req) => {
        delivered.push(req);
      },
      // Stands in for the server's record: the reply to the delivered message, by its id.
      awaitReply: ({ chatId, localId }) =>
        bridge.awaitReply(chatId, undefined, localId).then((reply) => reply.text),
      ledger: {} as VoiceLedger,
      logger,
      onCosted: () => {},
    });
    const cfg: VoiceConfig = {
      ...DEFAULT_VOICE_CONFIG,
    };
    const start = async () => {
      const handle = await startAudioServer({
        host: '127.0.0.1',
        port: 0,
        logger,
        internalToken: SECRET,
        whisper,
        kokoro: createKokoro({ backend: 'mock', logger }),
        makeVad: () => new SilentVad(),
        makeTimeline: () => ({
          userSaid() {},
          beginReply: () => ({ set() {}, finish() {} }),
        }),
        voiceAgentLink: {
          ...fakeVoiceAgentLink({
            passToAgent: (req) => agentTurns.push({ chatId: req.chatId, message: req.request }),
          }).link,
          findChats: (chatId, query) => lookup.findChats(query, chatId),
          sendToChat: (req) => glue.link.sendToChat(req),
        },
        getVoiceInstructions: () => DEFAULT_VOICE_INSTRUCTIONS,
        submitUserTurn: async ({ chatId, message }) => {
          agentTurns.push({ chatId, message });
          return 'the chat agent answered';
        },
        chatExists: () => true,
        getVoiceConfig: () => cfg,
        geminiApiKey: 'g-key',
        geminiWsCtor: function (this: unknown, url: string) {
          const inst = new FakeGeminiWs(url);
          queueMicrotask(() => inst.emit('open'));
          gemini.push(inst);
          return inst;
        } as unknown as new (url: string) => WsSocket,
        managerVoice,
        ...extra,
      });
      server = Object.assign(handle, { port: handle.address().port });
      return server;
    };
    return { start, gemini, agentTurns, managerNotes, delivered, playTurn };
  }

  test('the voice sends to a chat itself, and the chat reply reaches the call and the Manager chat', async () => {
    const t = setup();
    const s = await t.start();
    const call = await openCall(s.port, 'mgr-1', MANAGER_CHAT_ID);
    await until(() =>
      expect(call.events).toContainEqual(
        expect.objectContaining({ type: 'audio.state', state: 'listening' }),
      ),
    );
    const g = t.gemini[0]!;
    expect(g.toolNames()).toContain(SEND_TO_CHAT_TOOL_NAME);
    expect(g.toolNames()).not.toContain(PASS_TO_AGENT_TOOL_NAME);

    g.say({
      toolCall: { functionCalls: [{ id: 'f', name: FIND_CHATS_TOOL_NAME, args: { query: '' } }] },
    });
    await until(() => expect(g.responses()).toHaveLength(1));
    expect(g.responses()[0]!['response'].result).toContain('"Garden planning" (id c-garden)');

    g.say({
      toolCall: {
        functionCalls: [
          {
            id: 's',
            name: SEND_TO_CHAT_TOOL_NAME,
            args: { chat: 'garden planning', message: 'put ferns in the north bed' },
          },
        ],
      },
    });
    await until(() => expect(t.delivered).toHaveLength(1));
    expect(t.delivered[0]).toMatchObject({
      callerChatId: MANAGER_CHAT_ID,
      chatId: 'c-garden',
      message: 'put ferns in the north bed',
    });
    await until(() => expect(g.responses()).toHaveLength(2));
    expect(g.responses()[1]!['response'].result).toBe('received');

    t.playTurn('c-garden', t.delivered[0]!.localId, 'Added ferns to the north bed.');
    await until(() => expect(g.clientTurns()).toHaveLength(1));
    expect(g.clientTurns()[0]).toContain('"Garden planning" has answered');
    expect(g.clientTurns()[0]).toContain('Added ferns to the north bed.');
    expect(t.managerNotes).toEqual([
      '-> "Garden planning": put ferns in the north bed',
      '<- "Garden planning": Added ferns to the north bed.',
    ]);
    // The Manager's own agent never ran.
    expect(t.agentTurns).toEqual([]);
    call.ws.close();
  });

  test('a call on any other chat keeps handing off to that chat agent', async () => {
    const t = setup();
    const s = await t.start();
    const call = await openCall(s.port, 'plain-1', 'c-garden');
    await until(() =>
      expect(call.events).toContainEqual(
        expect.objectContaining({ type: 'audio.state', state: 'listening' }),
      ),
    );
    const g = t.gemini[0]!;
    expect(g.toolNames()).toEqual([
      PASS_TO_AGENT_TOOL_NAME,
      'check_status',
      'look_back',
      'find_chats',
      'chat_status',
      'send_to_chat',
      'end_call',
      'switch_chat',
    ]);
    g.say({
      toolCall: {
        functionCalls: [{ id: 'd', name: PASS_TO_AGENT_TOOL_NAME, args: { request: 'what next' } }],
      },
    });
    await until(() => expect(t.agentTurns).toEqual([{ chatId: 'c-garden', message: 'what next' }]));
    expect(t.delivered).toEqual([]);
    call.ws.close();
  });

  test('a hosted call to the Manager on a server without the manager tools is refused, by name', async () => {
    const t = setup({ managerVoice: undefined });
    const s = await t.start();
    const call = await openCall(s.port, 'mgr-2', MANAGER_CHAT_ID);
    await until(() =>
      expect(call.events).toContainEqual(
        expect.objectContaining({
          type: 'audio.error',
          code: 'voice_config_not_implemented',
          message: expect.stringContaining('Manager'),
        }),
      ),
    );
    expect(t.gemini).toHaveLength(0);
  });
});
