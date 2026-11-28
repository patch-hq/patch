// voiceEngines.ts — the one description of each voice engine's controls, and
// the setting it validates (spec/07 § The voice agent).

import { describe, expect, test } from 'vitest';
import {
  DEFAULT_VOICE_AGENT,
  DEFAULT_VOICE_CONFIG,
  VOICE_AGENT_ENGINES,
  VoiceAgentSetting,
  audioTagsFromTone,
  mergeConfig,
  soundConfig,
  soundProblem,
  soundValues,
  toneFor,
  voiceBackendFor,
  voiceCatalogView,
} from '../src/audio.js';
import { DEFAULT_SHARED_SETTINGS, SharedSettings } from '../src/events.js';

describe('engine descriptions', () => {
  test('each provider has only its own controls (spec/07 § The voice agent)', () => {
    const keys = (p: keyof typeof VOICE_AGENT_ENGINES) =>
      VOICE_AGENT_ENGINES[p].controls.map((c) => c.label);
    expect(keys('elevenlabs')).toEqual([
      'Speech model',
      'Tone',
      'Expressive mode',
      'Stability',
      'Similarity',
      'Speed',
      'Reply eagerness',
    ]);
    expect(keys('openai')).toEqual(['Tone', 'Speed']);
    expect(keys('gemini')).toEqual(['Tone', 'Match my tone']);
  });

  test('ElevenLabs defaults are calm: stability 0.7, speed 0.95, eagerness Patient', () => {
    expect(soundValues(VOICE_AGENT_ENGINES.elevenlabs, {})).toEqual({
      expressiveMode: true,
      stability: 0.7,
      similarity: 0.8,
      speed: 0.95,
      eagerness: 'patient',
    });
  });

  test('stored values win over defaults', () => {
    expect(soundValues(VOICE_AGENT_ENGINES.openai, { speed: 1.2 })).toEqual({ speed: 1.2 });
  });
});

describe('soundProblem', () => {
  test('refuses an unknown control, a wrong type, and a value out of bounds', () => {
    const el = VOICE_AGENT_ENGINES.elevenlabs;
    expect(soundProblem(el, { stability: 0.4 })).toBeNull();
    expect(soundProblem(el, { pitch: 1 })).toMatch(/no sound control "pitch"/);
    expect(soundProblem(el, { tone: 'x' })).toMatch(/no sound control "tone"/);
    expect(soundProblem(el, { stability: 2 })).toMatch(/Stability.*0–1/);
    expect(soundProblem(el, { expressiveMode: 'yes' })).toMatch(/Expressive mode/);
    expect(soundProblem(el, { eagerness: 'rushed' })).toMatch(/Reply eagerness/);
    expect(soundProblem(VOICE_AGENT_ENGINES.openai, { speed: 0.1 })).toMatch(/0.25–1.5/);
  });

  test('the setting refuses a sound its provider does not describe', () => {
    const bad = {
      ...DEFAULT_VOICE_AGENT,
      setups: { ...DEFAULT_VOICE_AGENT.setups, openai: { sound: { stability: 0.5 } } },
    };
    expect(VoiceAgentSetting.safeParse(bad).success).toBe(false);
    expect(VoiceAgentSetting.safeParse(DEFAULT_VOICE_AGENT).success).toBe(true);
  });
});

describe('soundConfig: the provider fields a sound sets', () => {
  test('ElevenLabs: tts and turn fields, and the tone tags only on a v3 speech model', () => {
    const tone = 'Calm. [slow] when explaining, [laughs] at jokes, [slow] again.';
    const v3 = soundConfig(
      VOICE_AGENT_ENGINES.elevenlabs,
      { speechModel: 'eleven_v3_conversational', eagerness: 'eager' },
      tone,
    );
    expect(v3).toEqual({
      tts: {
        model_id: 'eleven_v3_conversational',
        suggested_audio_tags: [{ tag: 'slow' }, { tag: 'laughs' }],
        expressive_mode: true,
        stability: 0.7,
        similarity_boost: 0.8,
        speed: 0.95,
      },
      turn: { turn_eagerness: 'eager' },
    });
    const flash = soundConfig(
      VOICE_AGENT_ENGINES.elevenlabs,
      { speechModel: 'eleven_flash_v2_5' },
      tone,
    );
    expect(flash['tts']).not.toHaveProperty('suggested_audio_tags');
    // No speech model chosen: ElevenLabs' default, no model_id sent and no tags.
    expect(soundConfig(VOICE_AGENT_ENGINES.elevenlabs, {}, tone)['tts']).not.toHaveProperty(
      'model_id',
    );
  });

  test('OpenAI: speed on the audio output', () => {
    expect(soundConfig(VOICE_AGENT_ENGINES.openai, { speed: 1.1 }, 'tone')).toEqual({
      audio: { output: { speed: 1.1 } },
    });
  });

  test('Gemini: affective dialog only when on', () => {
    expect(soundConfig(VOICE_AGENT_ENGINES.gemini, { matchTone: true }, undefined)).toEqual({
      generationConfig: { enableAffectiveDialog: true },
    });
    expect(soundConfig(VOICE_AGENT_ENGINES.gemini, {}, undefined)).toEqual({});
  });
});

describe('helpers', () => {
  test('audioTagsFromTone: each tag once, in order', () => {
    expect(audioTagsFromTone('[a] x [b] y [a] [ ]')).toEqual(['a', 'b']);
    expect(audioTagsFromTone('no tags')).toEqual([]);
  });

  test('toneFor: per voice; blank is none', () => {
    const tones = { 'openai:marin': 'Warm.', 'openai:cedar': '  ' };
    expect(toneFor(tones, 'openai', 'marin')).toBe('Warm.');
    expect(toneFor(tones, 'openai', 'cedar')).toBeUndefined();
    expect(toneFor(tones, 'gemini', 'marin')).toBeUndefined();
    expect(toneFor(tones, 'openai', undefined)).toBeUndefined();
  });

  test('mergeConfig merges objects key by key; extra wins', () => {
    expect(mergeConfig({ tts: { a: 1, b: 2 }, x: [1] }, { tts: { b: 3, c: 4 }, x: [2] })).toEqual({
      tts: { a: 1, b: 3, c: 4 },
      x: [2],
    });
  });
});

describe('voiceBackendFor', () => {
  test('a call and hands-free always run on the voice agent', () => {
    const agent = { ...DEFAULT_VOICE_AGENT, provider: 'openai' as const };
    expect(voiceBackendFor(DEFAULT_VOICE_CONFIG, agent, 'call')).toBe('openai');
    expect(voiceBackendFor(DEFAULT_VOICE_CONFIG, agent, 'hands-free')).toBe('openai');
  });

  test('a voice device answers directly when its setting says so, else on the voice agent', () => {
    const agent = { ...DEFAULT_VOICE_AGENT, provider: 'elevenlabs' as const };
    expect(voiceBackendFor(DEFAULT_VOICE_CONFIG, agent, 'device')).toBe('local');
    const onAgent = {
      ...DEFAULT_VOICE_CONFIG,
      deviceAnswer: 'agent',
    };
    expect(voiceBackendFor(onAgent, agent, 'device')).toBe('elevenlabs');
  });
});

describe('voiceCatalogView', () => {
  const ok = { at: 2, models: [{ id: 'm', label: 'M' }] };
  test('the freshest good read, online hosts first', () => {
    const view = voiceCatalogView('gemini', [
      { hostName: 'old', online: false, voiceCatalog: { gemini: { ...ok, at: 9 } } },
      { hostName: 'mac', online: true, voiceCatalog: { gemini: { at: 1, error: 'boom' } } },
      { hostName: 'box', online: true, voiceCatalog: { gemini: ok } },
    ]);
    expect(view).toEqual({ state: 'ready', entry: ok, hostName: 'box' });
  });

  test('a failure says why; a key with no read is loading; no key anywhere says so', () => {
    expect(
      voiceCatalogView('gemini', [
        { hostName: 'mac', online: true, voiceCatalog: { gemini: { at: 1, error: 'HTTP 403' } } },
      ]),
    ).toEqual({ state: 'failed', message: 'mac: HTTP 403' });
    expect(
      voiceCatalogView('openai', [{ hostName: 'mac', online: true, voiceKeys: { openai: true } }]),
    ).toEqual({ state: 'loading' });
    expect(voiceCatalogView('openai', [{ hostName: 'mac', online: true }])).toEqual({
      state: 'no-key',
    });
  });
});

describe('shared settings', () => {
  test('the new voice settings have their defaults, and are required', () => {
    expect(DEFAULT_SHARED_SETTINGS).toMatchObject({
      voiceAgent: DEFAULT_VOICE_AGENT,
      voiceTones: {},
      agentsCanCall: true,
      agentCallAutoAnswer: false,
      pauseWhenQuietMinutes: 0,
    });
    const { voiceAgent: _omitted, ...without } = DEFAULT_SHARED_SETTINGS;
    expect(SharedSettings.safeParse(without).success).toBe(false);
  });

  test('pause when quiet takes only the offered minutes', () => {
    expect(
      SharedSettings.safeParse({ ...DEFAULT_SHARED_SETTINGS, pauseWhenQuietMinutes: 7 }).success,
    ).toBe(false);
  });
});
