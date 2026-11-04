// ElevenLabs speech-out backend: request shape, streaming, usage, loud failures.
// Every request is a stub — nothing here reaches the provider or spends credits.

import { describe, test, expect, vi } from 'vitest';
import pino from 'pino';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ELEVENLABS_ANNOUNCE_MODEL,
  ELEVENLABS_LIVE_MODEL,
  createElevenLabs,
  createRoutedTts,
} from '../src/audio/elevenlabs.js';
import type { KokoroBackend } from '../src/audio/kokoro.js';
import { speechCostUsd, type SpeechUsage } from '../src/audio/voiceCost.js';
import { createVoiceLedger } from '../src/audio/voiceLedger.js';

const logger = pino({ level: 'silent' });

const streamOf = (...parts: number[][]): Response =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const p of parts) c.enqueue(new Uint8Array(p));
        c.close();
      },
    }),
    { status: 200 },
  );

async function drain(it: AsyncIterableIterator<{ pcm: Int16Array; first: boolean }>) {
  const out: { pcm: Int16Array; first: boolean }[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe('ElevenLabsBackend.synthesize', () => {
  test('requests 24 kHz PCM from the streaming endpoint with the live model', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(streamOf([1, 0, 2, 0]));
    const usage: SpeechUsage[] = [];
    const b = createElevenLabs({
      apiKey: 'k'.repeat(20),
      logger,
      fetchImpl,
      onUsage: (u) => usage.push(u),
      now: () => 5,
    });
    const s = await b.synthesize('Hello', 'voice1', { purpose: 'live' });
    const chunks = await drain(s.iterator);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/voice1/stream?output_format=pcm_24000',
    );
    expect(init.headers['xi-api-key']).toBe('k'.repeat(20));
    expect(JSON.parse(init.body)).toEqual({ text: 'Hello', model_id: ELEVENLABS_LIVE_MODEL });
    expect(chunks).toHaveLength(1);
    expect([...chunks[0]!.pcm]).toEqual([1, 2]);
    expect(chunks[0]!.first).toBe(true);
    expect(usage).toEqual([
      {
        kind: 'tts',
        provider: 'elevenlabs',
        model: ELEVENLABS_LIVE_MODEL,
        characters: 5,
        at: 5,
        usd: speechCostUsd(ELEVENLABS_LIVE_MODEL, 5),
      },
    ]);
  });

  test('announcements use the higher-quality model', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(streamOf([1, 0]));
    const b = createElevenLabs({ apiKey: 'k'.repeat(20), logger, fetchImpl });
    await b.synthesize('Dinner is ready', 'v', { purpose: 'announce' });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body).model_id).toBe(ELEVENLABS_ANNOUNCE_MODEL);
  });

  test('a sample split across network chunks is rejoined', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(streamOf([1, 0, 2], [0, 3, 0]));
    const b = createElevenLabs({ apiKey: 'k'.repeat(20), logger, fetchImpl });
    const chunks = await drain((await b.synthesize('x', 'v')).iterator);
    expect(chunks.flatMap((c) => [...c.pcm])).toEqual([1, 2, 3]);
    expect(chunks.map((c) => c.first)).toEqual([true, false]);
  });

  test('no key: throws, makes no request', async () => {
    const fetchImpl = vi.fn();
    const b = createElevenLabs({ apiKey: () => undefined, logger, fetchImpl });
    await expect(b.synthesize('x', 'v')).rejects.toThrow(/no ELEVEN_LABS_API_KEY/);
    expect(b.isReady()).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('no voice chosen: throws, makes no request', async () => {
    const fetchImpl = vi.fn();
    const b = createElevenLabs({ apiKey: 'k'.repeat(20), logger, fetchImpl });
    await expect(b.synthesize('x')).rejects.toThrow(/no voice is chosen/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a quota refusal surfaces the provider message and records no usage', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ detail: { status: 'quota_exceeded', message: 'out of credits' } }),
          { status: 401 },
        ),
      );
    const onUsage = vi.fn();
    const b = createElevenLabs({ apiKey: 'k'.repeat(20), logger, fetchImpl, onUsage });
    await expect(b.synthesize('x', 'v')).rejects.toThrow(/HTTP 401: quota_exceeded out of credits/);
    expect(onUsage).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('an empty stream is an error, not silence', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(streamOf());
    const b = createElevenLabs({ apiKey: 'k'.repeat(20), logger, fetchImpl });
    await expect(drain((await b.synthesize('x', 'v')).iterator)).rejects.toThrow(/empty audio/);
  });

  test('a transport failure is an error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const b = createElevenLabs({ apiKey: 'k'.repeat(20), logger, fetchImpl });
    await expect(b.synthesize('x', 'v')).rejects.toThrow(/socket hang up/);
  });

  test('cancel stops the stream without an error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(streamOf([1, 0]));
    const b = createElevenLabs({ apiKey: 'k'.repeat(20), logger, fetchImpl });
    const s = await b.synthesize('x', 'v');
    await s.cancel();
    await expect(drain(s.iterator)).resolves.toEqual([]);
  });
});

describe('ElevenLabsBackend.listVoices', () => {
  test('lists account voices including cloned ones', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          voices: [
            { voice_id: 'a', name: 'Rachel', category: 'premade' },
            { voice_id: 'b', name: 'Mine', category: 'cloned' },
          ],
        }),
      ),
    );
    const b = createElevenLabs({ apiKey: 'k'.repeat(20), logger, fetchImpl });
    expect(await b.listVoices()).toEqual([
      { id: 'a', name: 'Rachel', category: 'premade' },
      { id: 'b', name: 'Mine', category: 'cloned' },
    ]);
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.elevenlabs.io/v1/voices');
  });

  test('a refusal throws', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    const b = createElevenLabs({ apiKey: 'k'.repeat(20), logger, fetchImpl });
    await expect(b.listVoices()).rejects.toThrow(/voice list failed: HTTP 401: nope/);
  });
});

describe('createRoutedTts', () => {
  const fake = (name: string): KokoroBackend => ({
    synthesize: vi.fn().mockRejectedValue(new Error(`${name} down`)),
    isReady: () => name === 'kokoro',
    close: vi.fn().mockResolvedValue(undefined),
  });

  test('uses only the chosen engine and never falls back when it fails', async () => {
    const kokoro = fake('kokoro');
    const eleven = fake('eleven');
    let choice: 'kokoro' | 'elevenlabs' = 'elevenlabs';
    const tts = createRoutedTts({ kokoro, elevenlabs: eleven, choice: () => choice });
    await expect(tts.synthesize('x', 'v')).rejects.toThrow('eleven down');
    expect(kokoro.synthesize).not.toHaveBeenCalled();
    expect(tts.isReady()).toBe(false);
    choice = 'kokoro';
    await expect(tts.synthesize('x', 'v')).rejects.toThrow('kokoro down');
    expect(tts.isReady()).toBe(true);
    await tts.close();
    expect(kokoro.close).toHaveBeenCalled();
    expect(eleven.close).toHaveBeenCalled();
  });
});

describe('speech in the voice ledger', () => {
  test('counts toward spend, not calls, and survives a reload', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'u.jsonl');
    const now = Date.UTC(2026, 9, 29);
    const ledger = createVoiceLedger(path);
    ledger.recordSpeech({
      kind: 'tts',
      provider: 'elevenlabs',
      model: ELEVENLABS_LIVE_MODEL,
      characters: 600,
      at: now,
      usd: speechCostUsd(ELEVENLABS_LIVE_MODEL, 600),
    });
    const expected = 600 * 0.5 * (5 / 30_000);
    const t = createVoiceLedger(path).totals(now);
    expect(t.monthCalls).toBe(0);
    expect(t.monthUsd).toBeCloseTo(expected, 8);
    expect(t.allUsd).toBeCloseTo(expected, 8);
    expect(readFileSync(path, 'utf8')).toContain('"kind":"tts"');
  });

  test('an unknown model is priced null, never guessed', () => {
    expect(speechCostUsd('eleven_mystery', 100)).toBeNull();
  });
});

describe('ElevenLabsBackend Voice Design', () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  test('designVoicePreviews posts the description and records usage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      json({
        previews: [{ generated_voice_id: 'g1', audio_base_64: 'AAA=', duration_secs: 2 }],
        text: 'hello',
      }),
    );
    const usage: SpeechUsage[] = [];
    const b = createElevenLabs({
      apiKey: 'k'.repeat(20),
      logger,
      fetchImpl,
      onUsage: (u) => usage.push(u),
      now: () => 7,
    });
    const out = await b.designVoicePreviews('a calm voice');
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.elevenlabs.io/v1/text-to-voice/design');
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body).voice_description).toBe('a calm voice');
    expect(out).toEqual([
      { generatedVoiceId: 'g1', audioBase64: 'AAA=', durationSecs: 2, text: 'hello' },
    ]);
    expect(usage).toHaveLength(1);
    expect(usage[0]!.characters).toBe(5);
  });

  test('a refused design throws with the provider reason', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        json({ detail: { status: 'quota_exceeded', message: 'no credits' } }, 401),
      );
    const b = createElevenLabs({ apiKey: 'k'.repeat(20), logger, fetchImpl });
    await expect(b.designVoicePreviews('x')).rejects.toThrow(/quota_exceeded no credits/);
  });

  test('saveDesignedVoice returns the new voice id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ voice_id: 'v9' }));
    const b = createElevenLabs({ apiKey: 'k'.repeat(20), logger, fetchImpl });
    const v = await b.saveDesignedVoice({
      name: 'Patch',
      description: 'd',
      generatedVoiceId: 'g1',
    });
    expect(v.id).toBe('v9');
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body)).toEqual({
      voice_name: 'Patch',
      voice_description: 'd',
      generated_voice_id: 'g1',
    });
  });
});
