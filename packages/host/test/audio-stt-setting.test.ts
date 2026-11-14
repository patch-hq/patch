// Speech to text as an account setting (spec/07 § Speech to text): a
// turn-based call reads speech with the engine the account chose, and a host
// that cannot run it refuses the call by name — never reading with another.

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

async function call(
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
      surfaceKind: 'mobile',
      chatId: 'c1',
      role: 'voice-call',
      token: token(sessionId),
      surfaceHasAec: true,
      mode: 'call',
    }),
  );
  return { events, ws };
}

describe('createSpeechToTextResolver', () => {
  test('names the engine and why it cannot run, with no other engine offered', () => {
    const resolve = createSpeechToTextResolver({
      build: () => ({ unavailable: 'the Parakeet model is not installed on this host' }),
    });
    const r = resolve('parakeet');
    expect(r).toEqual({
      ok: false,
      engine: 'parakeet',
      message:
        'Speech to text is set to Parakeet on host, but the Parakeet model is not installed on this host. Switch Speech to text to another engine in Settings → Voice.',
    });
  });

  test('returns the backend the host built for that engine', () => {
    const groq = stub();
    const resolve = createSpeechToTextResolver({ build: () => ({ whisper: groq }) });
    expect(resolve('groq')).toEqual({ ok: true, whisper: groq });
  });
});

describe('audio server — speech to text setting on a turn-based call', () => {
  let server: (AudioServerHandle & { port: number }) | undefined;
  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  async function start(
    speechToText: SpeechToTextEngine,
    resolve: ReturnType<typeof createSpeechToTextResolver>,
  ): Promise<number> {
    const handle = await startAudioServer({
      makeTimeline: () => ({ userSaid() {}, beginReply: () => ({ append() {}, finish() {} }) }),
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
          return { unavailable: 'no ElevenLabs key is set on this host' };
        },
      }),
    );
    const c = await call(port, 'stt-refused');
    await vi.waitFor(() => expect(c.events.some((e) => e.type === 'audio.error')).toBe(true), {
      timeout: 2000,
    });
    expect(c.events).toEqual([
      {
        type: 'audio.error',
        code: 'whisper_unavailable',
        message:
          'Speech to text is set to ElevenLabs Scribe, but no ElevenLabs key is set on this host. Switch Speech to text to another engine in Settings → Voice.',
      },
    ]);
    expect(asked).toEqual(['elevenlabs']);
  });

  test('the call opens on the engine the account chose', async () => {
    const asked: SpeechToTextEngine[] = [];
    const port = await start(
      'whisper',
      createSpeechToTextResolver({
        build: (engine) => {
          asked.push(engine);
          return { whisper: stub() };
        },
      }),
    );
    const c = await call(port, 'stt-ok');
    await vi.waitFor(() => expect(c.events.some((e) => e.type === 'audio.state')).toBe(true), {
      timeout: 2000,
    });
    expect(c.events.some((e) => e.type === 'audio.error')).toBe(false);
    expect(asked).toEqual(['whisper']);
    c.ws.close();
  });
});
