// Speech to text as an account setting (spec/07 § Speech to text): a
// turn-based call reads speech with the engine the account chose, and a host
// that cannot run it refuses the call by name — never reading with another.

import { DEFAULT_VOICE_INSTRUCTIONS } from '@patch/wire';
import { fakeVoiceAgentLink } from './helpers/fakeVoiceAgentLink.js';
import { describe, test, expect, afterEach, vi } from 'vitest';
import pino from 'pino';
import { createHmac } from 'node:crypto';
import { WebSocket } from 'ws';
import { startAudioServer, type AudioServerHandle } from '../src/audio/server.js';
import { createSpeechToTextResolver } from '../src/audio/stt-engines.js';
import type { WhisperBackend } from '../src/audio/whisper.js';
import { createKokoro } from '../src/audio/kokoro.js';
import type { Vad, VadFrameResult } from '../src/audio/vad.js';
import {
  encodeAudio,
  decodeAudio,
  DEFAULT_VOICE_CONFIG,
  type AudioEvent,
  type SpeechToTextEngine,
  type VoiceKeys,
} from '@patch/wire/audio';

const SECRET = 'unit-test-internal-token-aaaaaaaaaa';
const logger = pino({ level: 'silent' });

function stub(): WhisperBackend {
  return {
    supportsLivePartials: false,
    async transcribe() {
      return 'x';
    },
    async transcribeClip() {
      return 'x';
    },
    async close() {},
  };
}

class SilentVad implements Vad {
  async feed(): Promise<VadFrameResult> {
    return { event: null };
  }
  reset(): void {}
  async close(): Promise<void> {}
}

function token(sessionId: string): string {
  const obj = {
    accountId: 'a',
    surfaceId: 'surf',
    sessionId,
    chatId: 'c1',
    exp: Date.now() + 60_000,
    jti: `jti-${Math.random().toString(36).slice(2)}`,
  };
  const b = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  return `${b}.${createHmac('sha256', SECRET).update(b).digest().toString('base64url')}`;
}

async function deviceConversation(
  port: number,
  sessionId: string,
): Promise<{ events: AudioEvent[]; ws: WebSocket }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/audio/${sessionId}`);
  const events: AudioEvent[] = [];
  ws.on('message', (d: Buffer, bin: boolean) => {
    if (!bin) events.push(decodeAudio(d));
  });
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  ws.send(
    encodeAudio({
      type: 'audio.session_start',
      sessionId,
      accountId: 'a',
      surfaceId: 'surf',
      surfaceKind: 'device',
      deviceId: 'surf',
      chatId: 'c1',
      role: 'voice-device-conv',
      token: token(sessionId),
      surfaceHasAec: false,
    }),
  );
  return { events, ws };
}

describe('createSpeechToTextResolver', () => {
  test('returns the backend the host built for that engine', () => {
    const groq = stub();
    const resolve = createSpeechToTextResolver({ build: () => groq });
    expect(resolve('groq')).toBe(groq);
  });
});

// A host-speech conversation: a voice device answering directly (spec/07 §
// Host speech engines). Calls from the app are always voice agent calls.
describe('audio server — speech to text setting on a host-speech conversation', () => {
  let server: (AudioServerHandle & { port: number }) | undefined;
  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  async function start(
    speechToText: SpeechToTextEngine,
    resolve: ReturnType<typeof createSpeechToTextResolver>,
    voiceKeys: Partial<VoiceKeys> = {},
    local: { kokoro: boolean } = { kokoro: true },
  ): Promise<number> {
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
      whisper: stub(),
      kokoro: createKokoro({ backend: 'mock', logger }),
      makeVad: () => new SilentVad(),
      submitUserTurn: async () => 'reply',
      chatExists: () => true,
      getVoiceConfig: () => ({ ...DEFAULT_VOICE_CONFIG, speechToText }),
      resolveSpeechToText: resolve,
      voiceFacts: () => ({
        hostName: 'the Mac',
        voiceKeys: { gemini: false, openai: false, groq: false, ...voiceKeys },
        localEngines: { whisper: true, parakeet: true, kokoro: local.kokoro },
      }),
    });
    server = Object.assign(handle, { port: handle.address().port });
    return server.port;
  }

  test('a host that cannot run the chosen engine refuses the call and says which', async () => {
    const asked: SpeechToTextEngine[] = [];
    const port = await start(
      'elevenlabs',
      createSpeechToTextResolver({
        build: (engine) => {
          asked.push(engine);
          return stub();
        },
      }),
    );
    const c = await deviceConversation(port, 'stt-refused');
    await vi.waitFor(() => expect(c.events.some((e) => e.type === 'audio.error')).toBe(true), {
      timeout: 2000,
    });
    expect(c.events).toEqual([
      {
        type: 'audio.error',
        code: 'whisper_unavailable',
        message:
          'Voice devices need an ElevenLabs key on the Mac. Set it up in Settings → Providers.',
      },
    ]);
    expect(asked).toEqual([]);
  });

  test('a spoken alert plays with no speech to text configured on the host', async () => {
    // Groq is chosen and this host has no Groq key: a call is refused (above),
    // but an announcement never listens, so it needs only speech.
    const asked: SpeechToTextEngine[] = [];
    const port = await start(
      'groq',
      createSpeechToTextResolver({
        build: (engine) => {
          asked.push(engine);
          return stub();
        },
      }),
    );
    const sessionId = 'announce-no-stt';
    const ws = new WebSocket(`ws://127.0.0.1:${port}/audio/${sessionId}`);
    const events: AudioEvent[] = [];
    ws.on('message', (d: Buffer, bin: boolean) => {
      if (!bin) events.push(decodeAudio(d));
    });
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId,
        accountId: 'a',
        surfaceId: 'surf',
        surfaceKind: 'web',
        chatId: 'c1',
        role: 'announcement',
        token: token(sessionId),
        surfaceHasAec: true,
      }),
    );
    ws.send(encodeAudio({ type: 'audio.speak', sessionId, text: 'The build finished.' }));
    await vi.waitFor(() => expect(events.some((e) => e.type === 'audio.tts_end')).toBe(true), {
      timeout: 3000,
    });
    expect(events.some((e) => e.type === 'audio.error')).toBe(false);
    expect(asked).toEqual([]);
    ws.close();
  });

  test('a spoken alert is refused, calmly named, when the host has no speech voice', async () => {
    const port = await start(
      'groq',
      createSpeechToTextResolver({ build: () => stub() }),
      {},
      {
        kokoro: false,
      },
    );
    const sessionId = 'announce-no-tts';
    const ws = new WebSocket(`ws://127.0.0.1:${port}/audio/${sessionId}`);
    const events: AudioEvent[] = [];
    ws.on('message', (d: Buffer, bin: boolean) => {
      if (!bin) events.push(decodeAudio(d));
    });
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId,
        accountId: 'a',
        surfaceId: 'surf',
        surfaceKind: 'web',
        chatId: 'c1',
        role: 'announcement',
        token: token(sessionId),
        surfaceHasAec: true,
      }),
    );
    await vi.waitFor(() => expect(events.some((e) => e.type === 'audio.error')).toBe(true), {
      timeout: 2000,
    });
    expect(events[0]).toMatchObject({
      code: 'kokoro_unavailable',
      message:
        'Spoken alerts need a speech voice on the Mac. Set it up in Settings → Hosts → Components.',
    });
  });

  test('the call opens on the engine the account chose', async () => {
    const asked: SpeechToTextEngine[] = [];
    const port = await start(
      'whisper',
      createSpeechToTextResolver({
        build: (engine) => {
          asked.push(engine);
          return stub();
        },
      }),
      { groq: true },
    );
    const c = await deviceConversation(port, 'stt-ok');
    await vi.waitFor(() => expect(c.events.some((e) => e.type === 'audio.state')).toBe(true), {
      timeout: 2000,
    });
    expect(c.events.some((e) => e.type === 'audio.error')).toBe(false);
    expect(asked).toEqual(['whisper']);
    c.ws.close();
  });
});
