// audio/server.ts × hosted voice backends (spec/07 § Voice — a config matrix).
//
// Every conversation surface a phone/web/desktop can open — hands-free, call —
// on every backend — local, gemini, openai — over a REAL audio WSS against
// fully faked providers: the Gemini Live and OpenAI Realtime sockets are
// in-memory fakes (the `geminiWsCtor` / `openaiWsCtor` hooks), and Whisper is a
// fake transcriber. No request leaves this process — both providers are paid
// APIs and this suite must never spend. Dictation on Deepgram is covered in
// audio-server-native-tier.test.ts.

import { DEFAULT_VOICE_INSTRUCTIONS } from '@patch/wire';
import { fakeVoiceAgentLink } from './helpers/fakeVoiceAgentLink.js';
import { describe, test, expect, afterEach, vi } from 'vitest';
import pino from 'pino';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { WebSocket as WsSocket } from 'ws';
import {
  startAudioServer,
  closeReason,
  type AudioServerHandle,
  type AudioServerOptions,
} from '../src/audio/server.js';
import type { WhisperBackend } from '../src/audio/whisper.js';
import { createKokoro } from '../src/audio/kokoro.js';
import type { Vad, VadFrameResult } from '../src/audio/vad.js';
import { DEFAULT_GEMINI_LIVE_MODEL } from '../src/audio/gemini-live.js';
import type { OpenAIWsCtor } from '../src/audio/openai-realtime.js';
import {
  encodeAudio,
  decodeAudio,
  DEFAULT_VOICE_AGENT,
  DEFAULT_VOICE_CONFIG,
  type AudioEvent,
  type AudioSessionMode,
  type AudioSessionRole,
  type VoiceAgentProvider,
  type VoiceAgentSetting,
  type VoiceConfig,
  type VoiceTones,
} from '@patch/wire/audio';

const SECRET = 'unit-test-internal-token-aaaaaaaaaa';
const logger = pino({ level: 'silent' });

function mintToken(sessionId: string, surfaceId = 'surf'): string {
  const obj = {
    accountId: 'a',
    surfaceId,
    sessionId,
    chatId: 'c1',
    exp: Date.now() + 60_000,
    jti: `jti-${Math.random().toString(36).slice(2)}`,
  };
  const claimsB64 = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  const sig = createHmac('sha256', SECRET).update(claimsB64).digest().toString('base64url');
  return `${claimsB64}.${sig}`;
}

/** A connected surface: every JSON frame it has received, and how its socket closed. */
interface Surface {
  ws: WebSocket;
  events: AudioEvent[];
  closed: Promise<number>;
}

async function openSurface(
  port: number,
  sessionId: string,
  role: AudioSessionRole,
  mode?: AudioSessionMode,
): Promise<Surface> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/audio/${sessionId}`);
  const events: AudioEvent[] = [];
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (!isBinary) events.push(decodeAudio(data));
  });
  const closed = new Promise<number>((resolve) =>
    ws.once('close', (code: number) => resolve(code)),
  );
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
      chatId: 'c1',
      role,
      token: mintToken(sessionId),
      surfaceHasAec: true,
      ...(mode ? { mode } : {}),
    }),
  );
  return { ws, events, closed };
}

class FakeGeminiWs extends EventEmitter {
  sent: string[] = [];
  constructor(public readonly url: string) {
    super();
  }
  send(data: string): void {
    this.sent.push(data);
    if ((JSON.parse(data) as { setup?: unknown }).setup) {
      queueMicrotask(() => this.emit('message', JSON.stringify({ setupComplete: {} }), false));
    }
  }
  close(): void {}
}

class FakeOpenAIWs extends EventEmitter {
  sent: Array<Record<string, unknown>> = [];
  constructor(
    public readonly url: string,
    public readonly opts: { headers: Record<string, string> },
  ) {
    super();
  }
  send(data: string): void {
    const msg = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(msg);
    if (msg['type'] === 'session.update' && this.sent.length === 1) {
      queueMicrotask(() => this.emit('message', JSON.stringify({ type: 'session.updated' })));
    }
  }
  close(): void {}
  /** Test helper: the provider sends an event. */
  serverSend(ev: unknown): void {
    this.emit('message', JSON.stringify(ev));
  }
}

/** A transcriber stand-in that records what it was asked to transcribe. */
function fakeTranscriber(text: string): WhisperBackend & { calls: number } {
  const t = {
    calls: 0,
    supportsLivePartials: false,
    async transcribe(): Promise<string> {
      t.calls += 1;
      return text;
    },
    async transcribeClip(): Promise<string> {
      t.calls += 1;
      return text;
    },
    async close(): Promise<void> {},
  };
  return t;
}

class SilentVad implements Vad {
  async feed(): Promise<VadFrameResult> {
    return { event: null };
  }
  reset(): void {}
  async close(): Promise<void> {}
}

const until = (fn: () => void): Promise<void> => vi.waitFor(fn, { timeout: 2000, interval: 5 });

describe('audio server — hosted backends on every app surface', () => {
  let server: (AudioServerHandle & { port: number }) | undefined;
  let gemini: FakeGeminiWs[] = [];
  let openai: FakeOpenAIWs[] = [];
  let eleven: Array<{ url: string }> = [];
  const elevenRest: string[] = [];
  const elevenBodies: Array<{ path: string; body: unknown }> = [];
  const submitted: Array<{ chatId: string; message: string }> = [];
  const transcribers = {
    local: fakeTranscriber('local words'),
  };

  afterEach(async () => {
    gemini = [];
    openai = [];
    eleven = [];
    elevenRest.length = 0;
    elevenBodies.length = 0;
    submitted.length = 0;
    for (const t of Object.values(transcribers)) t.calls = 0;
    if (server) await server.close();
    server = undefined;
  });

  async function start(
    voiceConfig: Partial<VoiceConfig>,
    keys: { gemini?: boolean; openai?: boolean; elevenlabs?: boolean } = {
      gemini: true,
      openai: true,
    },
    extra: Partial<AudioServerOptions> = {},
  ): Promise<AudioServerHandle & { port: number }> {
    const cfg: VoiceConfig = { ...DEFAULT_VOICE_CONFIG, ...voiceConfig };
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
      whisper: transcribers.local,
      kokoro: createKokoro({ backend: 'mock', logger }),
      makeVad: () => new SilentVad(),
      submitUserTurn: async ({ chatId, message }) => {
        submitted.push({ chatId, message });
        return 'heavy agent reply';
      },
      chatExists: () => true,
      getVoiceConfig: () => cfg,
      ...(keys.gemini ? { geminiApiKey: 'g-key' } : {}),
      ...(keys.openai ? { openaiApiKey: 'o-key' } : {}),
      ...(keys.elevenlabs ? { elevenLabsApiKey: 'e-key' } : {}),
      elevenLabsFetch: (async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname;
        elevenRest.push(`${init.method} ${path}`);
        if (typeof init.body === 'string') elevenBodies.push({ path, body: JSON.parse(init.body) });
        if (path === '/v1/convai/tools') return Response.json({ id: 't1' });
        if (path === '/v1/convai/agents/create') return Response.json({ agent_id: 'a1' });
        if (path.includes('get-signed-url')) return Response.json({ signed_url: 'wss://signed/c' });
        return Response.json({});
      }) as unknown as AudioServerOptions['elevenLabsFetch'],
      elevenLabsWsCtor: function (this: unknown, url: string) {
        const inst = Object.assign(new EventEmitter(), {
          url,
          send() {},
          close() {},
        });
        queueMicrotask(() => inst.emit('open'));
        eleven.push(inst);
        return inst;
      } as unknown as AudioServerOptions['elevenLabsWsCtor'],
      geminiWsCtor: function (this: unknown, url: string) {
        const inst = new FakeGeminiWs(url);
        queueMicrotask(() => inst.emit('open'));
        gemini.push(inst);
        return inst;
      } as unknown as new (url: string) => WsSocket,
      openaiWsCtor: function (
        this: unknown,
        url: string,
        opts: { headers: Record<string, string> },
      ) {
        const inst = new FakeOpenAIWs(url, opts);
        queueMicrotask(() => inst.emit('open'));
        openai.push(inst);
        return inst;
      } as unknown as OpenAIWsCtor,
      ...extra,
    });
    server = Object.assign(handle, { port: handle.address().port });
    return server;
  }

  // --- dictation × backend -------------------------------------------------

  test('dictation on Whisper: a committed note is transcribed by the host and dials no realtime session', async () => {
    const s = await start({ dictation: { phone: 'whisper', computer: 'whisper', tidy: false } });
    const surface = await openSurface(s.port, 'd-whisper', 'voice-note');
    await until(() => expect(surface.events.some((e) => e.type === 'audio.state')).toBe(true));
    surface.ws.send(Buffer.alloc(960), { binary: true });
    surface.ws.send(Buffer.alloc(960), { binary: true });
    await new Promise((r) => setTimeout(r, 20));
    surface.ws.send(encodeAudio({ type: 'audio.session_end', reason: 'committed' }));
    await until(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]!.message).toContain('local words');
    expect(transcribers.local.calls).toBe(1);
    expect(gemini).toHaveLength(0);
    expect(openai).toHaveLength(0);
    surface.ws.close();
  });

  // --- one conversation with the chat, and call cost (spec/07) -------------

  test('a Gemini call writes into the chat, is findable by chat, and is costed when it ends', async () => {
    const log: string[] = [];
    const started: string[] = [];
    const ended: Array<Parameters<NonNullable<AudioServerOptions['onCallEnded']>>[0]> = [];
    const s = await start({}, undefined, {
      ...on('gemini'),
      makeTimeline: () => ({
        userSaid: (chatId, text) => log.push(`user:${chatId}:${text}`),
        beginReply: (chatId) => {
          let text = '';
          return {
            append: (d) => {
              text += d;
            },
            finish: () => log.push(`reply:${chatId}:${text}`),
            text: () => text,
          };
        },
      }),
      onCallStarted: (init) => started.push(init.chatId),
      onCallEnded: (info) => ended.push(info),
    });
    const surface = await openSurface(s.port, 'conv', 'voice-call', 'call');
    await until(() =>
      expect(surface.events).toContainEqual(
        expect.objectContaining({ type: 'audio.state', state: 'listening' }),
      ),
    );
    expect(started).toHaveLength(1);
    const chatId = started[0]!;
    expect(s.sessionsOnChat(chatId)).toHaveLength(1);
    expect(s.sessionsOnChat('another-chat')).toHaveLength(0);

    const g = gemini[0]!;
    const say = (m: unknown): void => {
      g.emit('message', JSON.stringify(m), false);
    };
    say({ serverContent: { inputTranscription: { text: 'what is a nebula' } } });
    say({ serverContent: { outputTranscription: { text: 'A cloud of gas.' } } });
    say({
      serverContent: { turnComplete: true },
      usageMetadata: {
        promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 120 }],
        responseTokensDetails: [{ modality: 'AUDIO', tokenCount: 40 }],
      },
    });
    expect(log).toEqual([`user:${chatId}:what is a nebula`, `reply:${chatId}:A cloud of gas.`]);

    surface.ws.send(JSON.stringify({ type: 'audio.session_end' }));
    surface.ws.close();
    await until(() => expect(ended).toHaveLength(1));
    expect(ended[0]!.chatId).toBe(chatId);
    expect(ended[0]!.engine).toEqual({
      backend: 'gemini',
      model: DEFAULT_GEMINI_LIVE_MODEL,
      tokens: { textIn: 0, audioIn: 120, cachedIn: 0, textOut: 0, audioOut: 40 },
      stt: null,
    });
    expect(ended[0]!.endedAt).toBeGreaterThanOrEqual(ended[0]!.startedAt);
  });

  test('a dictation is never costed as a call', async () => {
    const ended: unknown[] = [];
    const s = await start({}, undefined, {
      onCallEnded: (info) => ended.push(info),
    });
    const surface = await openSurface(s.port, 'dict', 'voice-note');
    await until(() => expect(surface.events.some((e) => e.type === 'audio.state')).toBe(true));
    surface.ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(ended).toHaveLength(0);
  });

  // --- call / hands-free × provider ---------------------------------------

  /** The voice agent on `provider`, with `setup` over its default setup. */
  function on(
    provider: VoiceAgentProvider,
    setup: Partial<VoiceAgentSetting['setups'][VoiceAgentProvider]> = {},
    tones: VoiceTones = {},
  ): Partial<AudioServerOptions> {
    const agent: VoiceAgentSetting = {
      provider,
      setups: {
        ...DEFAULT_VOICE_AGENT.setups,
        [provider]: { ...DEFAULT_VOICE_AGENT.setups[provider], ...setup },
      },
    };
    return { getVoiceAgent: () => agent, getVoiceTones: () => tones };
  }

  for (const mode of ['call', 'hands-free'] as const) {
    test(`${mode} on gemini dials Gemini Live with the chosen model, voice, tone and sound`, async () => {
      const s = await start({}, undefined, {
        ...on(
          'gemini',
          { model: 'models/gemini-x', voice: 'Kore', sound: { matchTone: true } },
          { 'gemini:Kore': 'Calm and sincere.' },
        ),
      });
      const surface = await openSurface(s.port, `g-${mode}`, 'voice-call', mode);
      await until(() =>
        expect(surface.events).toContainEqual(
          expect.objectContaining({ type: 'audio.state', state: 'listening' }),
        ),
      );
      expect(gemini).toHaveLength(1);
      expect(openai).toHaveLength(0);
      const setup = JSON.parse(gemini[0]!.sent[0]!) as {
        setup: {
          model: string;
          generationConfig: Record<string, unknown>;
          systemInstruction: { parts: [{ text: string }] };
        };
      };
      expect(setup.setup.model).toBe('models/gemini-x');
      expect(setup.setup.generationConfig).toMatchObject({
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
        enableAffectiveDialog: true,
      });
      expect(setup.setup.systemInstruction.parts[0].text).toContain('Calm and sincere.');
      surface.ws.close();
    });

    test(`${mode} on openai dials OpenAI Realtime with the chosen model, speed and a bearer key`, async () => {
      const s = await start({}, undefined, on('openai', { model: 'gpt-x', sound: { speed: 1.2 } }));
      const surface = await openSurface(s.port, `o-${mode}`, 'voice-call', mode);
      await until(() =>
        expect(surface.events).toContainEqual(
          expect.objectContaining({ type: 'audio.state', state: 'listening' }),
        ),
      );
      expect(openai).toHaveLength(1);
      expect(gemini).toHaveLength(0);
      expect(openai[0]!.url).toContain('model=gpt-x');
      expect(openai[0]!.opts.headers['Authorization']).toBe('Bearer o-key');
      const update = openai[0]!.sent[0] as {
        session: {
          audio: {
            input: { turn_detection: { create_response: boolean } };
            output: { voice: string; speed: number };
          };
        };
      };
      // hands-free is gated by the address word: the provider must not answer on its own.
      expect(update.session.audio.input.turn_detection.create_response).toBe(mode === 'call');
      expect(update.session.audio.output).toMatchObject({ voice: 'marin', speed: 1.2 });
      surface.ws.close();
    });

    test(`${mode} on openai with no key is refused as voice_key_missing`, async () => {
      const s = await start({}, { gemini: true }, on('openai'));
      const surface = await openSurface(s.port, `o-nokey-${mode}`, 'voice-call', mode);
      await surface.closed;
      const label = mode === 'call' ? 'Call' : 'Hands-free';
      expect(surface.events).toEqual([
        {
          type: 'audio.error',
          code: 'voice_key_missing',
          message:
            `${label} is set to openai, but no OpenAI key is set on this host. ` +
            `Add it in Settings → Providers, or switch ${label} to another backend in Settings → Voice.`,
        },
      ]);
      expect(openai).toHaveLength(0);
    });

    test(`${mode} on elevenlabs with no key is refused as voice_key_missing`, async () => {
      const s = await start({}, undefined, on('elevenlabs'));
      const surface = await openSurface(s.port, `e-nokey-${mode}`, 'voice-call', mode);
      await surface.closed;
      const label = mode === 'call' ? 'Call' : 'Hands-free';
      expect(surface.events).toEqual([
        {
          type: 'audio.error',
          code: 'voice_key_missing',
          message:
            `${label} is set to elevenlabs, but no ElevenLabs key is set on this host. ` +
            `Add it in Settings → Providers, or switch ${label} to another backend in Settings → Voice.`,
        },
      ]);
      expect(eleven).toHaveLength(0);
      expect(elevenRest).toHaveLength(0);
    });

    test(`${mode} on elevenlabs provisions an agent with its sound and dials its signed URL`, async () => {
      const s = await start(
        {},
        { elevenlabs: true },
        on(
          'elevenlabs',
          {
            voice: 'v-rachel',
            sound: { speechModel: 'eleven_v3_conversational', eagerness: 'eager' },
          },
          { 'elevenlabs:v-rachel': 'Warm. [whispers] secrets, [laughs] at jokes.' },
        ),
      );
      const surface = await openSurface(s.port, `e-${mode}`, 'voice-call', mode);
      await until(() => expect(eleven).toHaveLength(1));
      expect(eleven[0]!.url).toBe('wss://signed/c');
      // One client tool each: pass_to_agent, check_status, look_back, find_chats, chat_status, end_call, switch_chat.
      expect(elevenRest).toEqual([
        'POST /v1/convai/tools',
        'POST /v1/convai/tools',
        'POST /v1/convai/tools',
        'POST /v1/convai/tools',
        'POST /v1/convai/tools',
        'POST /v1/convai/tools',
        'POST /v1/convai/tools',
        'POST /v1/convai/agents/create',
        'GET /v1/convai/conversation/get-signed-url',
      ]);
      const cc = (
        elevenBodies.find((b) => b.path === '/v1/convai/agents/create')!.body as {
          conversation_config: {
            agent: { prompt: { prompt: string; llm: string } };
            tts: Record<string, unknown>;
            turn: Record<string, unknown>;
          };
        }
      ).conversation_config;
      expect(cc.agent.prompt.llm).toBe('claude-haiku-4-5');
      expect(cc.agent.prompt.prompt).toContain('Warm. [whispers] secrets');
      expect(cc.tts).toMatchObject({
        voice_id: 'v-rachel',
        model_id: 'eleven_v3_conversational',
        stability: 0.7,
        similarity_boost: 0.8,
        speed: 0.95,
        expressive_mode: true,
        agent_output_audio_format: 'pcm_24000',
        suggested_audio_tags: [{ tag: 'whispers' }, { tag: 'laughs' }],
      });
      expect(cc.turn).toEqual({ turn_eagerness: 'eager' });
      expect(gemini).toHaveLength(0);
      expect(openai).toHaveLength(0);
      surface.ws.close();
    });
  }

  test('a stored model the provider no longer lists is refused at the start, naming it', async () => {
    const s = await start({}, undefined, {
      ...on('openai', { model: 'gpt-gone' }),
      getVoiceCatalog: () => ({ at: 1, models: [{ id: 'gpt-realtime-2.1', label: 'x' }] }),
    });
    const surface = await openSurface(s.port, 'o-gone', 'voice-call', 'call');
    await surface.closed;
    expect(surface.events[0]).toEqual({
      type: 'audio.error',
      code: 'openai_unavailable',
      message:
        "The voice agent's model gpt-gone is no longer offered by OpenAI. Choose another in Settings → Voice calls.",
    });
    expect(openai).toHaveLength(0);
  });

  test('an OpenAI session whose provider hangs up ends the surface session loudly', async () => {
    const s = await start({}, undefined, on('openai'));
    const surface = await openSurface(s.port, 'o-drop', 'voice-call', 'call');
    await until(() => expect(openai).toHaveLength(1));
    await until(() =>
      expect(surface.events).toContainEqual(
        expect.objectContaining({ type: 'audio.state', state: 'listening' }),
      ),
    );
    openai[0]!.emit('close', 1011, Buffer.from('server error'));
    const code = await surface.closed;
    expect(code).toBe(4400);
    expect(surface.events).toContainEqual(
      expect.objectContaining({
        type: 'audio.error',
        code: 'openai_unavailable',
        message: expect.stringContaining('1011'),
      }),
    );
  });

  test('a Gemini session whose provider hangs up ends the surface session loudly', async () => {
    const s = await start({}, undefined, on('gemini'));
    const surface = await openSurface(s.port, 'g-drop', 'voice-call', 'call');
    await until(() =>
      expect(surface.events).toContainEqual(
        expect.objectContaining({ type: 'audio.state', state: 'listening' }),
      ),
    );
    gemini[0]!.emit('close', 1008, Buffer.from('quota'));
    expect(await surface.closed).toBe(4400);
    expect(surface.events).toContainEqual(
      expect.objectContaining({ type: 'audio.error', code: 'gemini_unavailable' }),
    );
  });

  test('switching mode flips in place on the one voice agent: the provider turn detection follows', async () => {
    const s = await start({}, undefined, on('openai'));
    const surface = await openSurface(s.port, 'same-1', 'voice-call', 'call');
    await until(() =>
      expect(surface.events).toContainEqual(
        expect.objectContaining({ type: 'audio.state', state: 'listening' }),
      ),
    );
    surface.ws.send(encodeAudio({ type: 'audio.mode', sessionId: 'same-1', mode: 'hands-free' }));
    await until(() =>
      expect(openai[0]!.sent.filter((m) => m['type'] === 'session.update')).toHaveLength(2),
    );
    expect(surface.events.some((e) => e.type === 'audio.error')).toBe(false);
    surface.ws.close();
  });

  test('a device on openai runs it, and gets the reply upsampled to 48 kHz', async () => {
    const s = await start({ deviceAnswer: 'agent' }, undefined, on('openai'));
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/audio/dev-1`);
    const events: AudioEvent[] = [];
    const binaries: Buffer[] = [];
    ws.on('message', (d: Buffer, isBinary: boolean) => {
      if (isBinary) binaries.push(d);
      else events.push(decodeAudio(d));
    });
    await new Promise<void>((r) => ws.once('open', () => r()));
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId: 'dev-1',
        accountId: 'a',
        surfaceId: 'device-kitchen',
        surfaceKind: 'device',
        deviceId: 'device-kitchen',
        chatId: 'c1',
        role: 'voice-device-conv',
        token: mintToken('dev-1', 'device-kitchen'),
        surfaceHasAec: false,
      }),
    );
    await until(() => expect(openai).toHaveLength(1));
    // Two 20 ms pieces of 24 kHz audio from the provider.
    const piece = Buffer.alloc(480 * 2);
    for (let i = 0; i < 480; i++) piece.writeInt16LE(Math.round(8000 * Math.sin(i / 5)), i * 2);
    for (let k = 0; k < 2; k++) {
      openai[0]!.serverSend({
        type: 'response.output_audio.delta',
        delta: piece.toString('base64'),
      });
    }
    await until(() => expect(binaries.length).toBe(2));
    const samples = binaries.reduce((n, b) => n + b.length / 2, 0);
    // 960 in at 24 kHz is 1920 at 48 kHz, less the 32 held back for the next piece.
    expect(samples).toBe(1920 - 32);
    expect(events.some((e) => e.type === 'audio.error')).toBe(false);
    ws.close();
  });
});

describe('closeReason', () => {
  test('caps a close reason at 123 bytes on a character boundary', () => {
    const msg = `${'x'.repeat(121)}→ tail`;
    const reason = closeReason(msg);
    expect(Buffer.byteLength(reason, 'utf8')).toBeLessThanOrEqual(123);
    expect(reason).toBe('x'.repeat(121));
    expect(closeReason('short → fine')).toBe('short → fine');
  });
});
