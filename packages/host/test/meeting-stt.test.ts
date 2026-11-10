// Deepgram and AssemblyAI meeting engines (meeting-stt.ts): driven by a stub
// fetch only. No real request is made, so no money is spent.

import { describe, expect, test } from 'vitest';
import pino from 'pino';
import {
  AssemblyAiMeetingBackend,
  DeepgramMeetingBackend,
  MeetingSttError,
} from '../src/audio/meeting-stt.js';

const logger = pino({ level: 'silent' });
const wav = Buffer.alloc(100);
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

describe('DeepgramMeetingBackend', () => {
  test('asks for nova-3 with diarisation and merges consecutive same-speaker utterances', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const be = new DeepgramMeetingBackend({
      logger,
      apiKey: 'dg-key',
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return json({
          results: {
            utterances: [
              { speaker: 0, transcript: 'Hello.' },
              { speaker: 0, transcript: 'Shall we start?' },
              { speaker: 1, transcript: 'Yes.' },
            ],
          },
        });
      },
    });
    const runs = await be.transcribeDiarised(wav);
    expect(runs).toEqual([
      { speakerId: '0', text: 'Hello. Shall we start?' },
      { speakerId: '1', text: 'Yes.' },
    ]);
    expect(calls[0]!.url).toContain('model=nova-3');
    expect(calls[0]!.url).toContain('diarize=true');
    expect((calls[0]!.init.headers as Record<string, string>)['Authorization']).toBe(
      'Token dg-key',
    );
  });

  test('no key fails the clip', async () => {
    const be = new DeepgramMeetingBackend({ logger, apiKey: undefined });
    await expect(be.transcribeDiarised(wav)).rejects.toThrow(/Deepgram key is no longer set/);
  });

  test('an HTTP error fails the clip with the status', async () => {
    const be = new DeepgramMeetingBackend({
      logger,
      apiKey: 'k',
      fetchImpl: async () => new Response('nope', { status: 401 }),
    });
    await expect(be.transcribeDiarised(wav)).rejects.toThrow(/HTTP 401: nope/);
  });

  test('a body with no utterances is an error, not silence', async () => {
    const be = new DeepgramMeetingBackend({
      logger,
      apiKey: 'k',
      fetchImpl: async () => json({ results: {} }),
    });
    await expect(be.transcribeDiarised(wav)).rejects.toBeInstanceOf(MeetingSttError);
  });
});

describe('AssemblyAiMeetingBackend', () => {
  const make = (
    transcripts: unknown[],
    seen: string[] = [],
    opts: { timeoutMs?: number } = {},
  ): AssemblyAiMeetingBackend => {
    let poll = 0;
    return new AssemblyAiMeetingBackend({
      logger,
      apiKey: 'aai-key',
      sleep: async () => {},
      ...opts,
      fetchImpl: async (url, init) => {
        seen.push(`${init.method} ${url.replace('https://api.assemblyai.com/v2', '')}`);
        expect((init.headers as Record<string, string>)['Authorization']).toBe('aai-key');
        if (url.endsWith('/upload')) return json({ upload_url: 'https://cdn/x' });
        if (init.method === 'POST') {
          const body = JSON.parse(init.body as string) as Record<string, unknown>;
          expect(body['speaker_labels']).toBe(true);
          expect(body['audio_url']).toBe('https://cdn/x');
          return json({ id: 't1' });
        }
        return json(transcripts[Math.min(poll++, transcripts.length - 1)]);
      },
    });
  };

  test('uploads, creates, polls until completed and returns speaker runs', async () => {
    const seen: string[] = [];
    const be = make(
      [
        { status: 'queued' },
        { status: 'processing' },
        {
          status: 'completed',
          utterances: [
            { speaker: 'A', text: 'Morning.' },
            { speaker: 'B', text: 'Hi.' },
            { speaker: 'B', text: 'Ready?' },
          ],
        },
      ],
      seen,
    );
    expect(await be.transcribeDiarised(wav)).toEqual([
      { speakerId: 'A', text: 'Morning.' },
      { speakerId: 'B', text: 'Hi. Ready?' },
    ]);
    expect(seen).toEqual([
      'POST /upload',
      'POST /transcript',
      'GET /transcript/t1',
      'GET /transcript/t1',
      'GET /transcript/t1',
    ]);
  });

  test('silence completes with no runs', async () => {
    expect(await make([{ status: 'completed', utterances: null }]).transcribeDiarised(wav)).toEqual(
      [],
    );
  });

  test('a failed transcript fails the clip with the reason', async () => {
    await expect(
      make([{ status: 'error', error: 'bad audio' }]).transcribeDiarised(wav),
    ).rejects.toThrow(/bad audio/);
  });

  test('a clip that never finishes times out', async () => {
    await expect(
      make([{ status: 'processing' }], [], { timeoutMs: -1 }).transcribeDiarised(wav),
    ).rejects.toThrow(/timed out/);
  });

  test('no key fails the clip', async () => {
    const be = new AssemblyAiMeetingBackend({ logger, apiKey: undefined });
    await expect(be.transcribeDiarised(wav)).rejects.toThrow(/AssemblyAI key is no longer set/);
  });
});
