// Scribe diarisation for meetings (elevenlabs-stt.ts). A stub fetch stands in
// for ElevenLabs, so no credits are spent.

import { describe, expect, test } from 'vitest';
import pino from 'pino';
import {
  ElevenLabsScribeBackend,
  ScribeError,
  ScribeVoiceMap,
  scribeSpeakerRuns,
} from '../src/audio/elevenlabs-stt.js';

const logger = pino({ level: 'silent' });
const w = (text: string, speaker_id: string, type = 'word') => ({ text, type, speaker_id });
const sp = (text = ' ') => ({ text, type: 'spacing' });

describe('scribeSpeakerRuns', () => {
  test('groups by speaker and keeps audio events in the speaker run', () => {
    const runs = scribeSpeakerRuns([
      w('Hello', 'speaker_0'),
      sp(),
      w('there', 'speaker_0'),
      sp(),
      w('(laughter)', 'speaker_1', 'audio_event'),
      sp(),
      w('Hi', 'speaker_1'),
    ]);
    expect(runs).toEqual([
      { speakerId: 'speaker_0', text: 'Hello there' },
      { speakerId: 'speaker_1', text: '(laughter) Hi' },
    ]);
  });

  test('a word with no speaker fails loudly', () => {
    expect(() => scribeSpeakerRuns([{ text: 'x', type: 'word' }])).toThrow(ScribeError);
  });
});

describe('ScribeVoiceMap', () => {
  test('numbers speakers from 1 and a clip opens with the last clip’s closing voice', () => {
    const m = new ScribeVoiceMap();
    expect(
      m.assign([
        { speakerId: 'speaker_0', text: 'a' },
        { speakerId: 'speaker_1', text: 'b' },
      ]),
    ).toEqual([
      { text: 'a', voice: 1 },
      { text: 'b', voice: 2 },
    ]);
    // Next request relabels: its speaker_0 continues voice 2, speaker_1 is new.
    expect(
      m.assign([
        { speakerId: 'speaker_0', text: 'c' },
        { speakerId: 'speaker_1', text: 'd' },
        { speakerId: 'speaker_0', text: 'e' },
      ]),
    ).toEqual([
      { text: 'c', voice: 2 },
      { text: 'd', voice: 3 },
      { text: 'e', voice: 2 },
    ]);
  });
});

describe('ElevenLabsScribeBackend.transcribeDiarised', () => {
  test('requests diarisation and event tags with the key', async () => {
    let form!: FormData;
    let headers!: Record<string, string>;
    const backend = new ElevenLabsScribeBackend({
      logger,
      apiKey: () => 'k',
      fetchImpl: async (_url, init) => {
        form = init.body as FormData;
        headers = init.headers as Record<string, string>;
        return new Response(JSON.stringify({ words: [w('Hi', 'speaker_0')] }));
      },
    });
    const runs = await backend.transcribeDiarised(Buffer.alloc(100));
    expect(runs).toEqual([{ speakerId: 'speaker_0', text: 'Hi' }]);
    expect(form.get('diarize')).toBe('true');
    expect(form.get('tag_audio_events')).toBe('true');
    expect(headers['xi-api-key']).toBe('k');
  });

  test('quota or HTTP failure throws, no fallback', async () => {
    const backend = new ElevenLabsScribeBackend({
      logger,
      apiKey: () => 'k',
      fetchImpl: async () => new Response('quota_exceeded', { status: 401 }),
    });
    await expect(backend.transcribeDiarised(Buffer.alloc(100))).rejects.toThrow(/HTTP 401/);
  });

  test('a missing key throws', async () => {
    const backend = new ElevenLabsScribeBackend({ logger, apiKey: () => undefined });
    await expect(backend.transcribeDiarised(Buffer.alloc(100))).rejects.toThrow(
      /ELEVEN_LABS_API_KEY/,
    );
  });
});
