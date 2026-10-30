// Hosted dictation transcribers (hosted-stt.ts). `fetch` is faked — Deepgram is
// a paid API and nothing here may reach it.

import { describe, test, expect, vi } from 'vitest';
import pino from 'pino';
import {
  DeepgramTranscribeBackend,
  HostedSttError,
  createDictationTranscribers,
  pickDictationTranscriber,
} from '../src/audio/hosted-stt.js';
import type { WhisperBackend } from '../src/audio/whisper.js';

const logger = pino({ level: 'silent' });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('DeepgramTranscribeBackend (the clip path)', () => {
  test('posts the clip body with a Token key and reads the first transcript', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ results: { channels: [{ alternatives: [{ transcript: ' buy milk ' }] }] } }),
    );
    const t = new DeepgramTranscribeBackend({ logger, apiKey: 'dg-key', fetchImpl });
    expect(await t.transcribeClip(Buffer.from('RIFF....'), 'wav')).toBe('buy milk');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('https://api.deepgram.com/v1/listen?model=nova-3');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Token dg-key');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('audio/wav');
  });

  test('HTTP failure, network failure and a missing transcript all throw', async () => {
    const http = new DeepgramTranscribeBackend({
      logger,
      apiKey: 'k',
      fetchImpl: async () => new Response('nope', { status: 401 }),
    });
    await expect(http.transcribeClip(Buffer.from('x'), 'wav')).rejects.toThrow('HTTP 401');
    const net = new DeepgramTranscribeBackend({
      logger,
      apiKey: 'k',
      fetchImpl: async () => {
        throw new Error('ECONNRESET');
      },
    });
    await expect(net.transcribe(new Int16Array(10))).rejects.toBeInstanceOf(HostedSttError);
    const empty = new DeepgramTranscribeBackend({
      logger,
      apiKey: 'k',
      fetchImpl: async () => jsonResponse({ results: {} }),
    });
    await expect(empty.transcribeClip(Buffer.from('x'), 'wav')).rejects.toThrow('no transcript');
    const noKey = new DeepgramTranscribeBackend({ logger, apiKey: undefined });
    await expect(noKey.transcribeClip(Buffer.from('x'), 'wav')).rejects.toThrow('Deepgram key');
  });
});

describe('picking the dictation transcriber', () => {
  const local = { supportsLivePartials: true } as WhisperBackend;
  test('Deepgram exists only while the host holds its key', () => {
    expect(createDictationTranscribers({ logger, local }).deepgram).toBeUndefined();
    const t = createDictationTranscribers({ logger, local, deepgramApiKey: 'd' });
    expect(t.local).toBe(local);
    expect(t.deepgram).toBeInstanceOf(DeepgramTranscribeBackend);
  });
  test('Whisper and the phone recogniser read clips with Whisper; Deepgram with no key is refused, never Whisper', () => {
    const t = createDictationTranscribers({ logger, local });
    expect(pickDictationTranscriber('whisper', t)).toEqual({ ok: true, whisper: local });
    expect(pickDictationTranscriber('device', t)).toEqual({ ok: true, whisper: local });
    expect(pickDictationTranscriber('deepgram', t)).toEqual({
      ok: false,
      backend: 'deepgram',
      message:
        'Dictation is set to deepgram, but no Deepgram key is set on this host. ' +
        'Add it in Settings → Providers, or switch Dictation to another backend in Settings → Voice.',
    });
    const withKey = createDictationTranscribers({ logger, local, deepgramApiKey: 'd' });
    const picked = pickDictationTranscriber('deepgram', withKey);
    expect(picked.ok && picked.whisper).toBe(withKey.deepgram);
  });
});
