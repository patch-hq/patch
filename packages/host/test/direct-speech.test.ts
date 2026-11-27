// A direct call's cloud speech on the host (spec/07 § Direct calls): each
// request runs on exactly the engine, model, voice and sound it names, and a
// failure names the engine — never another engine's answer.
import { describe, expect, it, vi } from 'vitest';
import type { WireEvent } from '@patch/wire';
import {
  audioTags,
  directSpeak,
  directTranscribe,
  elevenLabsVoiceSettings,
  handleDirectSpeak,
  handleDirectTranscribe,
} from '../src/audio/direct-speech.js';

const logger = { warn: vi.fn() };
const keys = (k: Partial<Record<'groq' | 'elevenlabs' | 'openai', string>>) => (p: string) =>
  k[p as keyof typeof k];

function fakeFetch(res: Response): { fetch: typeof fetch; calls: [string, RequestInit][] } {
  const calls: [string, RequestInit][] = [];
  return {
    calls,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return res.clone();
    }) as unknown as typeof fetch,
  };
}

describe('directTranscribe', () => {
  it('reads an utterance with Groq on the chosen model', async () => {
    const f = fakeFetch(new Response(JSON.stringify({ text: ' hello there ' })));
    const text = await directTranscribe(
      { engine: 'groq', model: 'whisper-large-v3', audioBase64: 'UklGRg==' },
      { key: keys({ groq: 'g' }), fetchImpl: f.fetch, logger },
    );
    expect(text).toBe('hello there');
    const [url, init] = f.calls[0]!;
    expect(url).toContain('api.groq.com');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer g');
    const form = init.body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3');
    expect(form.get('language')).toBe('en');
  });

  it('reads an utterance with ElevenLabs Scribe', async () => {
    const f = fakeFetch(new Response(JSON.stringify({ text: 'hi' })));
    await directTranscribe(
      { engine: 'elevenlabs', audioBase64: 'UklGRg==' },
      { key: keys({ elevenlabs: 'e' }), fetchImpl: f.fetch, logger },
    );
    expect(f.calls[0]![0]).toContain('/v1/speech-to-text');
    expect((f.calls[0]![1].body as FormData).get('model_id')).toBe('scribe_v2');
  });

  it('a missing key is refused naming the engine and the key', async () => {
    await expect(
      directTranscribe({ engine: 'groq', audioBase64: 'AA==' }, { key: keys({}), logger }),
    ).rejects.toThrow(/^no Groq key is set on this host/);
  });
});

describe('directSpeak', () => {
  it('speaks with ElevenLabs as 24 kHz PCM with the device’s sound controls', async () => {
    const f = fakeFetch(new Response(new Uint8Array([1, 2, 3, 4])));
    const pcm = await directSpeak(
      {
        engine: 'elevenlabs',
        model: 'eleven_v3',
        voice: 'voice id',
        sound: { stability: 0.7, similarity: 0.8, speed: 0.95, tone: 'calm [whispers] please' },
        text: 'Done.',
      },
      { key: keys({ elevenlabs: 'e' }), fetchImpl: f.fetch, logger },
    );
    expect([...pcm]).toEqual([1, 2, 3, 4]);
    const [url, init] = f.calls[0]!;
    expect(url).toContain('/v1/text-to-speech/voice%20id?output_format=pcm_24000');
    expect(JSON.parse(init.body as string)).toEqual({
      text: '[whispers] Done.',
      model_id: 'eleven_v3',
      voice_settings: { stability: 0.7, similarity_boost: 0.8, speed: 0.95 },
    });
  });

  it('speaks with OpenAI, the tone as instructions', async () => {
    const f = fakeFetch(new Response(new Uint8Array([9, 9])));
    await directSpeak(
      {
        engine: 'openai',
        model: 'gpt-4o-mini-tts',
        voice: 'coral',
        sound: { tone: 'warm', speed: 1.1 },
        text: 'Hi.',
      },
      { key: keys({ openai: 'o' }), fetchImpl: f.fetch, logger },
    );
    expect(JSON.parse(f.calls[0]![1].body as string)).toEqual({
      model: 'gpt-4o-mini-tts',
      voice: 'coral',
      input: 'Hi.',
      response_format: 'pcm',
      speed: 1.1,
      instructions: 'warm',
    });
  });

  it('a provider failure names the engine and the reason', async () => {
    const f = fakeFetch(new Response('quota exceeded', { status: 429 }));
    await expect(
      directSpeak(
        { engine: 'openai', model: 'tts-1', voice: 'alloy', sound: {}, text: 'x' },
        { key: keys({ openai: 'o' }), fetchImpl: f.fetch, logger },
      ),
    ).rejects.toThrow('HTTP 429 — quota exceeded');
  });
});

describe('handlers answer every request', () => {
  it('a transcription answers with the text', async () => {
    const sent: WireEvent[] = [];
    const f = fakeFetch(new Response(JSON.stringify({ text: 'ok' })));
    await handleDirectTranscribe(
      {
        type: 'patch.voice.direct_transcribe_request',
        requestId: 'r1',
        chatId: 'c1',
        engine: 'groq',
        audioBase64: 'AA==',
      },
      { key: keys({ groq: 'g' }), fetchImpl: f.fetch, logger },
      (e) => sent.push(e),
    );
    expect(sent).toEqual([
      {
        type: 'patch.voice.direct_transcribe_response',
        requestId: 'r1',
        ok: true,
        transcript: 'ok',
      },
    ]);
  });

  it('speech with no key answers key_missing', async () => {
    const sent: WireEvent[] = [];
    await handleDirectSpeak(
      {
        type: 'patch.voice.direct_speak_request',
        requestId: 'r2',
        chatId: 'c1',
        engine: 'elevenlabs',
        model: 'eleven_flash_v2_5',
        voice: 'v',
        sound: {},
        text: 'x',
      },
      { key: keys({}), logger },
      (e) => sent.push(e),
    );
    expect(sent[0]).toMatchObject({
      ok: false,
      error: { code: 'key_missing', message: expect.stringMatching(/no ElevenLabs key/) },
    });
  });

  it('empty audio is a failure, not silence', async () => {
    const sent: WireEvent[] = [];
    const f = fakeFetch(new Response(new Uint8Array([])));
    await handleDirectSpeak(
      {
        type: 'patch.voice.direct_speak_request',
        requestId: 'r3',
        chatId: 'c1',
        engine: 'openai',
        model: 'tts-1',
        voice: 'alloy',
        sound: {},
        text: 'x',
      },
      { key: keys({ openai: 'o' }), fetchImpl: f.fetch, logger },
      (e) => sent.push(e),
    );
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'engine_failed' } });
  });
});

describe('helpers', () => {
  it('audio tags are only the bracketed parts of the tone', () => {
    expect(audioTags('slow [sighs] and [laughs]')).toBe('[sighs] [laughs]');
    expect(audioTags(undefined)).toBe('');
  });
  it('voice settings carry only what was set', () => {
    expect(elevenLabsVoiceSettings({})).toEqual({});
    expect(elevenLabsVoiceSettings({ style: 0.2 })).toEqual({ style: 0.2 });
  });
});
