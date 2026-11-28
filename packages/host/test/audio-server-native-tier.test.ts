// audio/server.ts voice-config wiring tests. Confirms which engine each
// surface runs on — a call and hands-free always on the voice agent, a voice
// device on the voice agent unless it answers directly —
// a real end-to-end WSS session against a fully mocked Gemini socket (via the
// `geminiWsCtor` test hook), not just gemini-live.ts's own unit tests.
//
//   - call, voice agent on Gemini               -> GeminiLiveSession (dials "Gemini")
//   - device answering with the voice agent      -> GeminiLiveSession too (a device is a surface like any other)
//   - dictation: the phone and the computer each run their own engine; Deepgram with no key -> voice_key_missing
//   - call, voice agent on Gemini, no key        -> audio.error{voice_key_missing}
//   - call, voice agent on OpenAI, no key        -> audio.error{voice_key_missing}
//   (each provider's working session is covered in audio-server-hosted-backends.test.ts)
//   - a call is never answered on host speech: with no key it is refused

import { DEFAULT_VOICE_INSTRUCTIONS } from '@patch/wire';
import { fakeVoiceAgentLink } from './helpers/fakeVoiceAgentLink.js';
import { describe, test, expect, afterEach } from 'vitest';
import pino from 'pino';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { WebSocket as WsSocket } from 'ws';
import { startAudioServer, type AudioServerHandle } from '../src/audio/server.js';
import { createWhisper } from '../src/audio/whisper.js';
import { createKokoro } from '../src/audio/kokoro.js';
import { MockVad } from '../src/audio/vad.js';
import {
  encodeAudio,
  decodeAudio,
  DEFAULT_VOICE_CONFIG,
  DEFAULT_VOICE_AGENT,
  type AudioEvent,
  type VoiceAgentProvider,
  type VoiceConfig,
} from '@patch/wire/audio';

const SECRET = 'unit-test-internal-token-aaaaaaaaaa';
const logger = pino({ level: 'silent' });

function mintToken(claims: {
  accountId: string;
  surfaceId: string;
  sessionId: string;
  chatId?: string;
}): string {
  const obj = {
    accountId: claims.accountId,
    surfaceId: claims.surfaceId,
    sessionId: claims.sessionId,
    chatId: claims.chatId ?? 'c',
    exp: Date.now() + 60_000,
    jti: `jti-${Math.random().toString(36).slice(2)}`,
  };
  const claimsB64 = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  const sig = createHmac('sha256', SECRET).update(claimsB64).digest().toString('base64url');
  return `${claimsB64}.${sig}`;
}

async function recvOne(ws: WebSocket): Promise<AudioEvent> {
  return new Promise<AudioEvent>((resolve, reject) => {
    ws.once('message', (data: Buffer | string, isBinary: boolean) => {
      if (isBinary) {
        reject(new Error('expected json frame, got binary'));
        return;
      }
      try {
        resolve(decodeAudio(data as string | Buffer));
      } catch (e) {
        reject(e as Error);
      }
    });
    ws.once('error', reject);
  });
}

async function openSocket(port: number, sessionId: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/audio/${sessionId}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}

/** A fake "Gemini Live" socket — never touches the network. */
class FakeGeminiWs extends EventEmitter {
  sent: string[] = [];
  constructor(public readonly url: string) {
    super();
  }
  send(data: string): void {
    this.sent.push(data);
    // Auto-answer setup so the session reaches 'listening' without the test
    // having to drive the handshake for every case.
    const parsed = JSON.parse(data) as { setup?: unknown };
    if (parsed.setup) {
      queueMicrotask(() => this.emit('message', JSON.stringify({ setupComplete: {} }), false));
    }
  }
  close(): void {}
}

let instances: FakeGeminiWs[] = [];
function makeGeminiWsCtor(): new (url: string) => WsSocket {
  return function (this: FakeGeminiWs, url: string): FakeGeminiWs {
    const inst = new FakeGeminiWs(url);
    // Fire 'open' on the next tick, like a real socket would.
    queueMicrotask(() => inst.emit('open'));
    instances.push(inst);
    return inst;
  } as unknown as new (url: string) => WsSocket;
}

describe('audio server — voice config matrix selection', () => {
  let server: AudioServerHandle & { port: number };

  afterEach(async () => {
    instances = [];
    if (server) await server.close();
  });

  async function startServer(opts: {
    voiceConfig?: Partial<VoiceConfig>;
    provider?: VoiceAgentProvider;
    geminiApiKey?: string;
    deepgramApiKey?: string;
    deepgramWsUrl?: string;
  }): Promise<AudioServerHandle & { port: number }> {
    const voiceConfig: VoiceConfig = { ...DEFAULT_VOICE_CONFIG, ...opts.voiceConfig };
    const handle = await startAudioServer({
      makeTimeline: () => ({
        userSaid() {},
        beginReply: () => ({ append() {}, finish() {}, text: () => '' }),
      }),
      voiceAgentLink: fakeVoiceAgentLink().link,
      getVoiceInstructions: () => DEFAULT_VOICE_INSTRUCTIONS,
      host: '127.0.0.1',
      port: 0,
      logger,
      internalToken: SECRET,
      whisper: createWhisper({ backend: 'mock', logger }),
      kokoro: createKokoro({ backend: 'mock', logger }),
      makeVad: () => new MockVad(),
      submitUserTurn: async () => 'mock reply',
      chatExists: () => true,
      getVoiceConfig: () => voiceConfig,
      getVoiceAgent: () => ({ ...DEFAULT_VOICE_AGENT, provider: opts.provider ?? 'gemini' }),
      ...(opts.geminiApiKey !== undefined ? { geminiApiKey: opts.geminiApiKey } : {}),
      geminiWsCtor: makeGeminiWsCtor(),
      ...(opts.deepgramApiKey !== undefined ? { deepgramApiKey: opts.deepgramApiKey } : {}),
      ...(opts.deepgramWsUrl !== undefined ? { deepgramWsUrl: opts.deepgramWsUrl } : {}),
    });
    const addr = handle.address();
    return Object.assign(handle, { port: addr.port });
  }

  test('a call on the Gemini voice agent dials the (fake) Gemini socket', async () => {
    server = await startServer({ provider: 'gemini', geminiApiKey: 'test-key' });
    const ws = await openSocket(server.port, 's-native-1');
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: 's-native-1',
        accountId: 'a',
        surfaceId: 'surf',
        surfaceKind: 'web',
        chatId: 'c1',
        role: 'voice-call',
        token: mintToken({
          accountId: 'a',
          surfaceId: 'surf',
          sessionId: 's-native-1',
          chatId: 'c1',
        }),
        surfaceHasAec: true,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(instances.length).toBe(1);
    // Its setup message is the Gemini Live shape, not anything Whisper/Kokoro would send.
    const setup = JSON.parse(instances[0]!.sent[0]!) as { setup?: { model?: string } };
    expect(setup.setup?.model).toBeDefined();
    ws.close();
  });

  test('a device answering with the voice agent dials Gemini Live like any other surface', async () => {
    server = await startServer({
      voiceConfig: { deviceAnswer: 'agent' },
      geminiApiKey: 'test-key',
    });
    const ws = await openSocket(server.port, 's-device-1');
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: 's-device-1',
        accountId: 'a',
        surfaceId: 'device-kitchen',
        surfaceKind: 'device',
        deviceId: 'device-kitchen',
        chatId: 'c1',
        role: 'voice-device-conv',
        token: mintToken({
          accountId: 'a',
          surfaceId: 'device-kitchen',
          sessionId: 's-device-1',
          chatId: 'c1',
        }),
        surfaceHasAec: false,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(instances.length).toBe(1);
    ws.close();
  });

  function dictationStart(sessionId: string, surfaceKind: 'mobile' | 'web' = 'mobile'): string {
    return encodeAudio({
      type: 'audio.session_start',
      sessionId,
      accountId: 'a',
      surfaceId: 'surf',
      surfaceKind,
      chatId: 'c1',
      role: 'voice-note',
      token: mintToken({ accountId: 'a', surfaceId: 'surf', sessionId, chatId: 'c1' }),
      surfaceHasAec: true,
    });
  }
  const dictation = (tidy = false): Partial<VoiceConfig> => ({
    dictation: { phone: 'deepgram', computer: 'deepgram', tidy },
  });

  test('the phone and the computer each dictate on their own engine', async () => {
    // Phone on Deepgram with no key: refused. Computer on Whisper: runs.
    server = await startServer({
      voiceConfig: { dictation: { phone: 'deepgram', computer: 'whisper', tidy: false } },
    });
    const phone = await openSocket(server.port, 's-dg-phone');
    phone.send(dictationStart('s-dg-phone', 'mobile'));
    expect(await recvOne(phone)).toMatchObject({ type: 'audio.error', code: 'voice_key_missing' });
    phone.close();

    const web = await openSocket(server.port, 's-wh-web');
    web.send(dictationStart('s-wh-web', 'web'));
    const first = await recvOne(web);
    expect(first.type).not.toBe('audio.error');
    web.close();
  });

  test("dictation on 'deepgram' with no DEEPGRAM_API_KEY refuses the session", async () => {
    server = await startServer({ voiceConfig: dictation() });
    const ws = await openSocket(server.port, 's-dg-nokey');
    ws.send(dictationStart('s-dg-nokey'));
    const msg = await recvOne(ws);
    expect(msg).toMatchObject({
      type: 'audio.error',
      code: 'voice_key_missing',
      message: expect.stringContaining('Deepgram key'),
    });
    ws.close();
  });

  test("dictation on 'deepgram' streams to Deepgram and a finish answers with its words", async () => {
    const { WebSocketServer } = await import('ws');
    const dg = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((r) => dg.on('listening', () => r()));
    let binary = 0;
    dg.on('connection', (sock) => {
      sock.on('message', (data, isBinary) => {
        if (isBinary) {
          binary += 1;
          return;
        }
        if ((JSON.parse(String(data)) as { type: string }).type === 'Finalize') {
          sock.send(
            JSON.stringify({
              type: 'Results',
              start: 0,
              duration: 1,
              is_final: true,
              from_finalize: true,
              channel: { alternatives: [{ transcript: 'buy oat milk' }] },
            }),
          );
        }
      });
    });
    try {
      server = await startServer({
        voiceConfig: dictation(),
        deepgramApiKey: 'dg-test-key-0000000000',
        deepgramWsUrl: `ws://127.0.0.1:${(dg.address() as { port: number }).port}/v1/listen`,
      });
      const ws = await openSocket(server.port, 's-dg-1');
      const events: AudioEvent[] = [];
      ws.on('message', (d: Buffer, isBinary: boolean) => {
        if (!isBinary) events.push(decodeAudio(d));
      });
      ws.send(dictationStart('s-dg-1'));
      ws.send(encodeAudio({ type: 'audio.pcm16', ts: 1, sampleRate: 16000, samples: 640 }));
      ws.send(Buffer.alloc(1280), { binary: true });
      for (let i = 0; i < 100 && binary === 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(binary).toBe(1);
      ws.send(encodeAudio({ type: 'audio.dictation_finish', sessionId: 's-dg-1' }));
      for (let i = 0; i < 100 && !events.some((e) => e.type === 'audio.transcript_final'); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(events.find((e) => e.type === 'audio.transcript_final')).toMatchObject({
        text: 'buy oat milk',
      });
      ws.close();
    } finally {
      await new Promise<void>((r) => dg.close(() => r()));
    }
  });

  test('a dictation finish on a non-streaming engine is refused, not ignored', async () => {
    server = await startServer({});
    const ws = await openSocket(server.port, 's-dg-local');
    ws.send(dictationStart('s-dg-local'));
    await new Promise((r) => setTimeout(r, 50));
    ws.send(encodeAudio({ type: 'audio.dictation_finish', sessionId: 's-dg-local' }));
    let msg = await recvOne(ws);
    while (msg.type !== 'audio.error') msg = await recvOne(ws);
    expect(msg).toMatchObject({ code: 'invalid_frame' });
    ws.close();
  });

  test('a call on the Gemini voice agent with no GEMINI_API_KEY refuses the session', async () => {
    server = await startServer({ provider: 'gemini' });
    const ws = await openSocket(server.port, 's-nokey-1');
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: 's-nokey-1',
        accountId: 'a',
        surfaceId: 'surf',
        surfaceKind: 'web',
        chatId: 'c1',
        role: 'voice-call',
        token: mintToken({
          accountId: 'a',
          surfaceId: 'surf',
          sessionId: 's-nokey-1',
          chatId: 'c1',
        }),
        surfaceHasAec: true,
      }),
    );
    const msg = await recvOne(ws);
    expect(msg.type).toBe('audio.error');
    expect(msg).toMatchObject({
      code: 'voice_key_missing',
      message: 'Calls need a Gemini key on this host. Set it up in Settings → Providers.',
    });
    expect(instances.length).toBe(0);
    ws.close();
  });

  test('a call on the OpenAI voice agent with no OPENAI_REALTIME_API_KEY refuses the session', async () => {
    server = await startServer({ provider: 'openai' });
    const ws = await openSocket(server.port, 's-openai-1');
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: 's-openai-1',
        accountId: 'a',
        surfaceId: 'surf',
        surfaceKind: 'web',
        chatId: 'c1',
        role: 'voice-call',
        token: mintToken({
          accountId: 'a',
          surfaceId: 'surf',
          sessionId: 's-openai-1',
          chatId: 'c1',
        }),
        surfaceHasAec: true,
      }),
    );
    const msg = await recvOne(ws);
    expect(msg.type).toBe('audio.error');
    expect(msg).toMatchObject({
      code: 'voice_key_missing',
      message: 'Calls need an OpenAI key on this host. Set it up in Settings → Providers.',
    });
    expect(instances.length).toBe(0);
    ws.close();
  });

  test('a spoken alert (announcement) runs on host speech: no key needed, nothing dials', async () => {
    server = await startServer({});
    const ws = await openSocket(server.port, 's-alert-1');
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: 's-alert-1',
        accountId: 'a',
        surfaceId: 'surf',
        surfaceKind: 'mobile',
        chatId: 'c1',
        role: 'announcement',
        token: mintToken({
          accountId: 'a',
          surfaceId: 'surf',
          sessionId: 's-alert-1',
          chatId: 'c1',
        }),
        surfaceHasAec: true,
      }),
    );
    const msg = await recvOne(ws);
    expect(msg.type).not.toBe('audio.error');
    expect(instances.length).toBe(0);
    ws.close();
  });

  test('a call is never answered on host speech: with no key it is refused, and nothing dials', async () => {
    server = await startServer({});
    const ws = await openSocket(server.port, 's-fb-1');
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: 's-fb-1',
        accountId: 'a',
        surfaceId: 'surf',
        surfaceKind: 'web',
        chatId: 'c1',
        role: 'voice-call',
        token: mintToken({ accountId: 'a', surfaceId: 'surf', sessionId: 's-fb-1', chatId: 'c1' }),
        surfaceHasAec: true,
      }),
    );
    const msg = await recvOne(ws);
    expect(msg).toMatchObject({ type: 'audio.error', code: 'voice_key_missing' });
    expect(instances.length).toBe(0);
    ws.close();
  });
});
