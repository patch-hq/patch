// ElevenLabs Scribe (elevenlabs-stt.ts, elevenlabs-dictation.ts): driven against
// a local stand-in for the realtime endpoint and a stub fetch. No real
// ElevenLabs request is made, so no credits are spent.

import { afterEach, describe, expect, test } from 'vitest';
import pino from 'pino';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import type { AudioEvent } from '@patch/wire/audio';
import { ElevenLabsDictationSession } from '../src/audio/elevenlabs-dictation.js';
import { ElevenLabsScribeBackend, ScribeError } from '../src/audio/elevenlabs-stt.js';
import { pickDictationTranscriber } from '../src/audio/hosted-stt.js';
import { costCall, callSummaryLine } from '../src/audio/voiceCost.js';

const logger = pino({ level: 'silent' });
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (cond()) return;
    await tick(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Fake {
  url: string;
  socket: () => Promise<WsSocket>;
  chunks: Array<{ audio_base_64: string; commit: boolean; sample_rate: number }>;
  headers: Record<string, string | string[] | undefined>;
  query: string;
  close: () => Promise<void>;
}

async function fakeScribe(onCommit?: (s: WsSocket) => void): Promise<Fake> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.on('listening', () => r()));
  let resolveSock!: (s: WsSocket) => void;
  const sockP = new Promise<WsSocket>((r) => (resolveSock = r));
  const fake: Fake = {
    url: '',
    socket: () => sockP,
    chunks: [],
    headers: {},
    query: '',
    close: () => new Promise((r) => wss.close(() => r())),
  };
  wss.on('connection', (sock, req) => {
    fake.headers = req.headers;
    fake.query = req.url ?? '';
    sock.on('message', (data) => {
      const msg = JSON.parse(String(data));
      fake.chunks.push(msg);
      if (msg.commit) onCommit?.(sock);
    });
    resolveSock(sock);
  });
  fake.url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}/v1/speech-to-text/realtime`;
  return fake;
}

const open: Fake[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

function session(fake: Fake, apiKey: string | undefined = 'xi-key') {
  const events: AudioEvent[] = [];
  const s = new ElevenLabsDictationSession(
    { sessionId: 's1', chatId: 'c1' },
    { logger, apiKey, sendAudio: (e) => events.push(e), wsUrl: fake.url },
  );
  return { s, events };
}

describe('ElevenLabs dictation', () => {
  test('streams PCM, shows partials live and finishes with the committed words', async () => {
    const fake = await fakeScribe((sock) =>
      sock.send(JSON.stringify({ message_type: 'committed_transcript', text: 'hello world' })),
    );
    open.push(fake);
    const { s, events } = session(fake);
    s.onSessionStart();
    await s.onMicFrame(new Int16Array(1600).fill(1000));
    const sock = await fake.socket();
    await until(() => fake.chunks.length === 1, 'audio chunk');
    expect(fake.headers['xi-api-key']).toBe('xi-key');
    expect(fake.query).toContain('model_id=scribe_v2_realtime');
    expect(fake.chunks[0]).toMatchObject({ commit: false, sample_rate: 16000 });
    sock.send(JSON.stringify({ message_type: 'partial_transcript', text: 'hello wor' }));
    await until(() => events.some((e) => e.type === 'audio.transcript_partial'), 'partial');
    await s.finishDictation();
    expect(fake.chunks.at(-1)).toMatchObject({ commit: true });
    const final = events.find((e) => e.type === 'audio.transcript_final');
    expect(final).toMatchObject({ text: 'hello world' });
    expect(s.engineCosting().stt?.audioSeconds).toBeCloseTo(0.1);
    await s.close();
  });

  test('a provider error fails the dictation loudly', async () => {
    const fake = await fakeScribe();
    open.push(fake);
    const { s, events } = session(fake);
    s.onSessionStart();
    const sock = await fake.socket();
    sock.send(JSON.stringify({ message_type: 'quota_exceeded', error: 'out of credits' }));
    await until(() => events.some((e) => e.type === 'audio.error'), 'error');
    expect(events.find((e) => e.type === 'audio.error')).toMatchObject({
      code: 'elevenlabs_unavailable',
    });
    await s.finishDictation();
    expect(events.some((e) => e.type === 'audio.transcript_final')).toBe(false);
    await s.close();
  });

  test('a missing key fails, not falls back', async () => {
    const fake = await fakeScribe();
    open.push(fake);
    const { s, events } = session(fake, '');
    s.onSessionStart();
    expect(events.find((e) => e.type === 'audio.error')).toMatchObject({
      code: 'elevenlabs_unavailable',
    });
  });
});

describe('ElevenLabs clip backend', () => {
  const wav = Buffer.from('RIFF');
  test('posts the clip with the key and returns the text', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const b = new ElevenLabsScribeBackend({
      logger,
      apiKey: 'xi-key',
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return new Response(JSON.stringify({ text: ' hi there ' }));
      },
    });
    expect(await b.transcribeClip(wav, 'wav')).toBe('hi there');
    expect(seen?.url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect((seen?.init.headers as Record<string, string>)['xi-api-key']).toBe('xi-key');
    expect((seen?.init.body as FormData).get('model_id')).toBe('scribe_v2');
  });

  test('HTTP failure throws with the status', async () => {
    const b = new ElevenLabsScribeBackend({
      logger,
      apiKey: 'k',
      fetchImpl: async () => new Response('quota', { status: 429 }),
    });
    await expect(b.transcribeClip(wav, 'wav')).rejects.toThrow(/HTTP 429/);
  });

  test('no key throws', async () => {
    const b = new ElevenLabsScribeBackend({ logger, apiKey: undefined });
    await expect(b.transcribeClip(wav, 'wav')).rejects.toBeInstanceOf(ScribeError);
  });

  test('the live stream streams to Scribe and reports text', async () => {
    const fake = await fakeScribe();
    open.push(fake);
    const b = new ElevenLabsScribeBackend({ logger, apiKey: 'k', wsUrl: fake.url });
    const texts: string[] = [];
    const stream = b.openLiveStream(
      (t) => texts.push(t),
      () => {},
    );
    stream.push(new Int16Array(16000));
    const sock = await fake.socket();
    await until(() => fake.chunks.length === 1, 'chunk');
    sock.send(JSON.stringify({ message_type: 'partial_transcript', text: 'one two' }));
    await until(() => texts.length === 1, 'text');
    expect(texts[0]).toBe('one two');
    expect(stream.audioSeconds).toBe(1);
    stream.close();
  });
});

describe('picking and costing', () => {
  const local = {} as never;
  test('elevenlabs engine without a key is refused, with a key is picked', () => {
    const refused = pickDictationTranscriber('elevenlabs', { local });
    expect(refused).toMatchObject({ ok: false, backend: 'elevenlabs' });
    const el = {} as never;
    expect(pickDictationTranscriber('elevenlabs', { local, elevenlabs: el })).toEqual({
      ok: true,
      whisper: el,
    });
  });

  test('Scribe usage is recorded and its price is unknown, not guessed', () => {
    const c = costCall({
      sessionId: 's',
      chatId: 'c',
      surfaceKind: 'phone',
      startedAt: 0,
      endedAt: 60000,
      engine: {
        backend: 'local',
        model: 'scribe_v2',
        tokens: null,
        stt: { requests: 1, audioSeconds: 12, billedSeconds: 12 },
      },
      handoffs: 0,
    });
    expect(c.engineUsd).toBeNull();
    expect(c.stt?.audioSeconds).toBe(12);
    expect(callSummaryLine(c)).toContain('ElevenLabs Scribe · price unknown');
  });
});
