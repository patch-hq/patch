// voiceCatalog.ts — each voice provider's models and voices, read from its own
// API with this host's key (spec/07 § The voice agent, § Direct calls).

import { describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_VOICE_AGENT,
  GEMINI_VOICES,
  OPENAI_TTS_VOICES,
  OPENAI_VOICES,
} from '@patch/wire/audio';
import {
  VoiceCatalogStore,
  readVoiceCatalog,
  voiceAgentChoiceRefusal,
  type CatalogFetch,
} from '../src/audio/voiceCatalog.js';

/** A fetch answering each path from `routes`; anything else is a 404. */
function fakeFetch(routes: Record<string, unknown>): CatalogFetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    calls.push(`${u.pathname}${u.search} ${JSON.stringify(init.headers)}`);
    const body = routes[`${u.pathname}${u.search}`] ?? routes[u.pathname];
    if (body === undefined) return new Response('nope', { status: 404 });
    if (body instanceof Response) return body;
    return Response.json(body);
  }) as CatalogFetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe('readVoiceCatalog', () => {
  test('Gemini: only Live models, every page, with the documented voices', async () => {
    const fetchImpl = fakeFetch({
      '/v1beta/models?pageSize=1000': {
        models: [
          {
            name: 'models/gemini-live-b',
            displayName: 'Live B',
            supportedGenerationMethods: ['bidiGenerateContent'],
          },
          { name: 'models/gemini-text', supportedGenerationMethods: ['generateContent'] },
        ],
        nextPageToken: 'p2',
      },
      '/v1beta/models?pageSize=1000&pageToken=p2': {
        models: [
          {
            name: 'models/gemini-live-a',
            displayName: 'Live A',
            supportedGenerationMethods: ['generateContent', 'bidiGenerateContent'],
          },
        ],
      },
    });
    const read = await readVoiceCatalog('gemini', 'g-key', { fetchImpl });
    expect(read.models).toEqual([
      { id: 'models/gemini-live-a', label: 'Live A' },
      { id: 'models/gemini-live-b', label: 'Live B' },
    ]);
    expect(read.voices?.map((v) => v.id)).toEqual([...GEMINI_VOICES]);
    expect(fetchImpl.calls[0]).toContain('"x-goog-api-key":"g-key"');
  });

  test('OpenAI: realtime models (not transcription ones) and speech models, with the documented voices', async () => {
    const fetchImpl = fakeFetch({
      '/v1/models': {
        data: [
          { id: 'gpt-realtime-2.1' },
          { id: 'gpt-4o-mini' },
          { id: 'tts-1' },
          { id: 'gpt-4o-mini-tts' },
          { id: 'gpt-realtime-2.1-mini' },
          { id: 'gpt-4o-transcribe-realtime' },
        ],
      },
    });
    const read = await readVoiceCatalog('openai', 'o-key', { fetchImpl });
    expect(read.models?.map((m) => m.id)).toEqual(['gpt-realtime-2.1', 'gpt-realtime-2.1-mini']);
    expect(read.voices?.map((v) => v.id)).toEqual([...OPENAI_VOICES]);
    expect(read.speechModels?.map((m) => m.id)).toEqual(['gpt-4o-mini-tts', 'tts-1']);
    expect(read.speechVoices?.map((v) => v.id)).toEqual([...OPENAI_TTS_VOICES]);
    expect(fetchImpl.calls[0]).toContain('"authorization":"Bearer o-key"');
  });

  test('ElevenLabs: agent LLMs (not deprecated), every page of voices, and speech models', async () => {
    const fetchImpl = fakeFetch({
      '/v1/convai/llm/list': {
        llms: [{ llm: 'claude-haiku-4-5' }, { llm: 'gpt-old', deprecation_info: { at: 1 } }],
      },
      '/v2/voices?page_size=100': {
        voices: [{ voice_id: 'v2', name: 'Zed', category: 'premade' }],
        has_more: true,
        next_page_token: 't2',
      },
      '/v2/voices?page_size=100&next_page_token=t2': {
        voices: [{ voice_id: 'v1', name: 'Mine', category: 'generated' }],
        has_more: false,
        next_page_token: null,
      },
      '/v1/models': [
        {
          model_id: 'eleven_v3_conversational',
          name: 'Eleven v3 conversational',
          can_do_text_to_speech: true,
        },
        { model_id: 'eleven_sts', name: 'STS', can_do_text_to_speech: false },
      ],
    });
    const read = await readVoiceCatalog('elevenlabs', 'e-key', { fetchImpl });
    expect(read.models).toEqual([{ id: 'claude-haiku-4-5', label: 'claude-haiku-4-5' }]);
    expect(read.voices).toEqual([
      { id: 'v1', label: 'Mine (designed)' },
      { id: 'v2', label: 'Zed' },
    ]);
    expect(read.speechModels).toEqual([
      { id: 'eleven_v3_conversational', label: 'Eleven v3 conversational' },
    ]);
    // ElevenLabs' API lists no speech to text models: Scribe's documented one.
    expect(read.transcriptionModels).toEqual([{ id: 'scribe_v2', label: 'scribe_v2' }]);
  });

  test('Groq: its active Whisper models, read from its API', async () => {
    const fetchImpl = fakeFetch({
      '/openai/v1/models': {
        data: [
          { id: 'whisper-large-v3-turbo', active: true },
          { id: 'llama-3.3-70b-versatile', active: true },
          { id: 'whisper-large-v3', active: true },
          { id: 'distil-whisper-large-v3-en', active: false },
        ],
      },
    });
    const read = await readVoiceCatalog('groq', 'q-key', { fetchImpl });
    expect(read.transcriptionModels?.map((m) => m.id)).toEqual([
      'whisper-large-v3',
      'whisper-large-v3-turbo',
    ]);
    expect(fetchImpl.calls[0]).toContain('"authorization":"Bearer q-key"');
  });

  test('a failed read throws with the provider’s reason, never an empty list', async () => {
    const fetchImpl = fakeFetch({ '/v1/models': new Response('bad key', { status: 401 }) });
    await expect(readVoiceCatalog('openai', 'o-key', { fetchImpl })).rejects.toThrow(
      'OpenAI model list failed: HTTP 401 — bad key',
    );
  });
});

describe('VoiceCatalogStore', () => {
  test('reads providers with a key, reports a failure with its reason, and drops one whose key went', async () => {
    const keys: Record<string, string | undefined> = { openai: 'o-key' };
    const onChange = vi.fn();
    const onError = vi.fn();
    const store = new VoiceCatalogStore({
      key: (p) => keys[p],
      onChange,
      onError,
      now: () => 42,
      fetchImpl: fakeFetch({ '/v1/models': { data: [{ id: 'gpt-realtime' }] } }),
    });
    await store.refreshAll();
    expect(store.snapshot()).toEqual({
      openai: {
        models: [{ id: 'gpt-realtime', label: 'gpt-realtime' }],
        speechModels: [],
        voices: OPENAI_VOICES.map((v) => ({ id: v, label: v })),
        speechVoices: OPENAI_TTS_VOICES.map((v) => ({ id: v, label: v })),
        at: 42,
      },
    });
    keys['gemini'] = 'g-key';
    await store.refresh('gemini');
    expect(store.entry('gemini')).toMatchObject({
      at: 42,
      error: expect.stringContaining('HTTP 404'),
    });
    expect(onError).toHaveBeenCalledWith(
      'gemini',
      expect.stringContaining('Gemini model list failed'),
    );
    keys['openai'] = undefined;
    await store.refresh('openai');
    expect(store.entry('openai')).toBeUndefined();
    expect(onChange).toHaveBeenCalledTimes(3);
  });
});

describe('voiceAgentChoiceRefusal', () => {
  const catalog = {
    at: 1,
    models: [{ id: 'claude-haiku-4-5', label: 'x' }],
    voices: [{ id: 'v1', label: 'x' }],
    speechModels: [{ id: 'eleven_flash_v2_5', label: 'x' }],
  };
  const agent = (setup: object) => ({
    ...DEFAULT_VOICE_AGENT,
    provider: 'elevenlabs' as const,
    setups: {
      ...DEFAULT_VOICE_AGENT.setups,
      elevenlabs: { model: 'claude-haiku-4-5', voice: 'v1', sound: {}, ...setup },
    },
  });

  test('a setup the provider still offers opens', () => {
    expect(voiceAgentChoiceRefusal(agent({}), catalog)).toBeNull();
  });

  test('a model, voice or speech model no longer offered is refused, naming it', () => {
    expect(voiceAgentChoiceRefusal(agent({ model: 'gone' }), catalog)).toBe(
      "The voice agent's model gone is no longer offered by ElevenLabs. Choose another in Settings → Voice calls.",
    );
    expect(voiceAgentChoiceRefusal(agent({ voice: 'v9' }), catalog)).toMatch(/voice v9/);
    expect(
      voiceAgentChoiceRefusal(agent({ sound: { speechModel: 'eleven_v9' } }), catalog),
    ).toMatch(/speech model eleven_v9/);
  });

  test('no model chosen is refused; with no read on this host, the provider decides', () => {
    expect(voiceAgentChoiceRefusal(agent({ model: undefined }), undefined)).toBe(
      'No ElevenLabs model is chosen for the voice agent. Choose one in Settings → Voice calls.',
    );
    expect(voiceAgentChoiceRefusal(agent({ model: 'anything' }), undefined)).toBeNull();
    expect(voiceAgentChoiceRefusal(agent({ model: 'anything' }), { at: 1, error: 'x' })).toBeNull();
  });
});
