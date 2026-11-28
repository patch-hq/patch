import { describe, expect, it } from 'vitest';
import {
  agentWorkingLabel,
  changeDirectCall,
  directCallSteps,
  kokoroVoiceLabel,
  cloudSpeechEnginesFromHosts,
  mergeSpeechEngines,
  directCallSummary,
  DirectCallSetup,
  NO_SPEECH_ENGINE,
  NOT_SET_UP,
  resolveDirectCall,
  speakablePieces,
  type SpeechEngineReport,
} from '../src/direct-call.js';

const desktop: SpeechEngineReport = {
  stt: [
    { engine: 'groq', where: 'cloud', models: ['whisper-large-v3-turbo'] },
    { engine: 'parakeet', where: 'device', models: ['parakeet-tdt-0.6b-v3'] },
  ],
  tts: [
    { engine: 'elevenlabs', where: 'cloud', models: ['eleven_flash_v2_5'], voices: ['v1', 'v2'] },
    { engine: 'kokoro', where: 'device', models: ['kokoro-82m'], voices: ['af_heart'] },
  ],
};

describe('resolveDirectCall', () => {
  it('a device with no engine for a step has No speech engine', () => {
    expect(resolveDirectCall({ stt: [], tts: [] }, undefined, {})).toEqual({
      ok: false,
      reason: NO_SPEECH_ENGINE,
    });
    expect(resolveDirectCall({ stt: desktop.stt, tts: [] }, undefined, {})).toEqual({
      ok: false,
      reason: NO_SPEECH_ENGINE,
    });
  });

  it('with no setup saved the device is not set up: nothing is chosen for it', () => {
    expect(resolveDirectCall(desktop, undefined, {})).toEqual({ ok: false, reason: NOT_SET_UP });
    expect(
      resolveDirectCall(
        desktop,
        { stt: { engine: 'parakeet', model: 'parakeet-tdt-0.6b-v3' } },
        {},
      ),
    ).toEqual({ ok: false, reason: NOT_SET_UP });
    // A setup missing a model or a voice is not finished either.
    expect(
      resolveDirectCall(
        desktop,
        {
          stt: { engine: 'parakeet' },
          tts: { engine: 'kokoro', model: 'kokoro-82m', voice: 'af_heart' },
        },
        {},
      ),
    ).toEqual({ ok: false, reason: NOT_SET_UP });
    const done = resolveDirectCall(
      desktop,
      {
        stt: { engine: 'parakeet', model: 'parakeet-tdt-0.6b-v3' },
        tts: { engine: 'kokoro', model: 'kokoro-82m', voice: 'af_heart' },
      },
      {},
    );
    expect(done.ok && directCallSummary(done.call)).toBe('Parakeet → Kokoro');
  });

  it('runs the saved setup: the engine’s controls, stored or default, and the voice’s tone', () => {
    const r = resolveDirectCall(
      desktop,
      {
        stt: { engine: 'groq', model: 'whisper-large-v3-turbo' },
        tts: {
          engine: 'elevenlabs',
          model: 'eleven_flash_v2_5',
          voice: 'v2',
          sound: { stability: 0.5 },
        },
      },
      { 'elevenlabs:v2': 'calm', 'elevenlabs:v1': 'brisk' },
    );
    expect(r.ok && r.call.tts).toEqual({
      engine: 'elevenlabs',
      where: 'cloud',
      model: 'eleven_flash_v2_5',
      voice: 'v2',
      sound: { stability: 0.5, similarity: 0.8, style: 0, speed: 0.95, tone: 'calm' },
    });
    // A model or voice the device no longer reports is refused, naming it.
    const gone = resolveDirectCall(
      desktop,
      {
        stt: { engine: 'groq', model: 'whisper-old' },
        tts: { engine: 'kokoro', model: 'kokoro-82m', voice: 'af_heart' },
      },
      {},
    );
    expect(!gone.ok && gone.reason).toMatch(/no longer has the model whisper-old/);
  });

  it('a stored sound must fit its engine’s description', () => {
    const bad = DirectCallSetup.safeParse({
      stt: { engine: 'parakeet' },
      tts: { engine: 'kokoro', sound: { stability: 0.2 } },
    });
    expect(bad.success).toBe(false);
    expect(
      DirectCallSetup.safeParse({
        stt: { engine: 'groq' },
        tts: { engine: 'openai', sound: { speed: 2 } },
      }).success,
    ).toBe(true);
  });

  it('refuses an engine the device does not report, naming it, never swapping', () => {
    const r = resolveDirectCall(
      desktop,
      { stt: { engine: 'android' }, tts: { engine: 'kokoro' } },
      {},
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/speech to text is set to Android, which it does not have/);
    const t = resolveDirectCall(
      desktop,
      { stt: { engine: 'groq' }, tts: { engine: 'openai' } },
      {},
    );
    expect(!t.ok && t.reason).toMatch(/text to speech is set to OpenAI/);
  });

  it('a cloud voice engine with no voice listed is refused', () => {
    const r = resolveDirectCall(
      {
        stt: desktop.stt,
        tts: [{ engine: 'elevenlabs', where: 'cloud', models: ['m'], voices: [] }],
      },
      {
        stt: { engine: 'groq', model: 'whisper-large-v3-turbo' },
        tts: { engine: 'elevenlabs', model: 'm' },
      },
      {},
    );
    expect(!r.ok && r.reason).toMatch(/ElevenLabs has no voice/);
  });
});

describe('speakablePieces', () => {
  it('drops code and markdown marks and joins short sentences', () => {
    expect(
      speakablePieces(
        '## Done\n\nI fixed **the bug** in `main.ts`. See [the PR](https://x/1).\n\n```ts\nconst x = 1;\n```\nOk.',
      ),
    ).toEqual(['Done. I fixed the bug in main.ts. See the PR. Ok.']);
  });
  it('splits a long reply at sentence ends', () => {
    const a = 'This is the first sentence and it is long enough to stand alone.';
    const b = 'This is the second sentence which also stands on its own.';
    expect(speakablePieces(`${a} ${b}`)).toEqual([a, b]);
  });
  it('an empty reply has nothing to say', () => {
    expect(speakablePieces('```\ncode\n```')).toEqual([]);
  });
});

describe('agentWorkingLabel', () => {
  it('counts minutes and seconds', () => {
    expect(agentWorkingLabel(42_000)).toBe('Agent working · 0:42');
    expect(agentWorkingLabel(125_400)).toBe('Agent working · 2:05');
  });
});

describe('cloudSpeechEnginesFromHosts', () => {
  const item = (id: string) => ({ id, label: id });
  const catalog = {
    groq: { transcriptionModels: [item('whisper-large-v3-turbo')], at: 2 },
    elevenlabs: {
      voices: [item('v1'), item('v2')],
      speechModels: [item('eleven_flash_v2_5')],
      transcriptionModels: [item('scribe_v2')],
      at: 2,
    },
    openai: { speechModels: [item('tts-1')], speechVoices: [item('coral')], at: 2 },
  };

  it('offers each engine the account holds a key for, with the lists its provider returned', () => {
    const r = cloudSpeechEnginesFromHosts([
      {
        hostName: 'a',
        online: true,
        providerKeys: [
          { id: 'groq', source: 'none' },
          { id: 'openai', source: 'env' },
        ],
      },
      {
        hostName: 'b',
        online: true,
        providerKeys: [{ id: 'elevenlabs', source: 'ui' }],
        voiceCatalog: catalog,
      },
    ]);
    expect(r.stt).toEqual([{ engine: 'elevenlabs', where: 'cloud', models: ['scribe_v2'] }]);
    expect(r.tts).toEqual([
      { engine: 'elevenlabs', where: 'cloud', models: ['eleven_flash_v2_5'], voices: ['v1', 'v2'] },
      { engine: 'openai', where: 'cloud', models: ['tts-1'], voices: ['coral'] },
    ]);
    const merged = mergeSpeechEngines(
      { stt: [{ engine: 'parakeet', where: 'device', models: ['p'] }], tts: [] },
      r,
    );
    expect(merged.stt.map((e) => e.engine)).toEqual(['parakeet', 'elevenlabs']);
  });

  it('a list that failed or was never read is empty and says why — never a built-in list', () => {
    const r = cloudSpeechEnginesFromHosts([
      {
        hostName: 'box',
        online: true,
        providerKeys: [
          { id: 'groq', source: 'ui' },
          { id: 'openai', source: 'ui' },
        ],
        voiceKeys: { groq: true, openai: true },
        voiceCatalog: { groq: { error: 'HTTP 401', at: 1 } },
      },
    ]);
    expect(r.stt).toEqual([
      {
        engine: 'groq',
        where: 'cloud',
        models: [],
        listProblem: 'the model list could not be read (box: HTTP 401)',
      },
    ]);
    expect(r.tts[0]).toMatchObject({
      engine: 'openai',
      models: [],
      voices: [],
      listProblem: 'the model list has not been read yet',
    });
  });

  it('a setup on an engine whose list could not be read is refused with why', () => {
    const report = {
      stt: [
        {
          engine: 'groq' as const,
          where: 'cloud' as const,
          models: [],
          listProblem: 'the model list could not be read (box: HTTP 401)',
        },
      ],
      tts: [{ engine: 'kokoro' as const, where: 'device' as const, models: ['k'], voices: ['af'] }],
    };
    const setup = {
      stt: { engine: 'groq' as const, model: 'whisper-large-v3-turbo' },
      tts: { engine: 'kokoro' as const, model: 'k', voice: 'af' },
    };
    expect(resolveDirectCall(report, setup, {})).toEqual({
      ok: false,
      reason: 'Groq Whisper: the model list could not be read (box: HTTP 401).',
    });
    // Settings shows the list's own line at the step, so the setup's problem is not repeated.
    expect(directCallSteps(report, setup, {}).problem).toBeUndefined();
  });
});

describe('Settings steps (directCallSteps / changeDirectCall)', () => {
  it('offers only what the device reported, on-device first; with nothing saved, nothing is chosen', () => {
    const s = directCallSteps(desktop, undefined, {});
    expect(s.stt.options).toEqual([
      { engine: 'parakeet', label: 'Parakeet', where: 'device' },
      { engine: 'groq', label: 'Groq Whisper', where: 'cloud' },
    ]);
    expect(s.tts.options.map((o) => o.engine)).toEqual(['kokoro', 'elevenlabs']);
    expect(s.stt.engine).toBeUndefined();
    expect(s.tts.engine).toBeUndefined();
    expect(s.summary).toBe('Set up');
    expect(s.problem).toBeUndefined();
  });

  it('a device with nothing reported for a step reads No speech engine', () => {
    const s = directCallSteps({ stt: desktop.stt, tts: [] }, undefined, {});
    expect(s.summary).toBe(NO_SPEECH_ENGINE);
    expect(s.problem).toBeUndefined();
  });

  it('a stored engine the device no longer reports stays chosen, with the reason', () => {
    const s = directCallSteps(
      desktop,
      { stt: { engine: 'android' }, tts: { engine: 'kokoro' } },
      {},
    );
    expect(s.stt.engine).toBe('android');
    expect(s.summary).toBe('Set up');
    expect(s.problem).toMatch(/Android, which it does not have/);
  });

  it('changing an engine starts the steps after it over; other changes keep the rest', () => {
    const setup = {
      stt: { engine: 'groq' as const, model: 'whisper-large-v3-turbo' },
      tts: {
        engine: 'elevenlabs' as const,
        model: 'eleven_flash_v2_5',
        voice: 'v2',
        sound: { stability: 0.4 },
      },
    };
    const s = directCallSteps(desktop, setup, {});
    expect(changeDirectCall(s, { step: 'tts', engine: 'kokoro' })).toEqual({
      stt: setup.stt,
      tts: { engine: 'kokoro' },
    });
    // Speech to text is the first step: every step after it is chosen again.
    expect(changeDirectCall(s, { step: 'stt', engine: 'parakeet' })).toEqual({
      stt: { engine: 'parakeet' },
    });
    expect(changeDirectCall(s, { step: 'sttModel', model: 'whisper-large-v3' })).toEqual({
      stt: { engine: 'groq', model: 'whisper-large-v3' },
      tts: setup.tts,
    });
    expect(changeDirectCall(s, { step: 'voice', voice: 'v1' }).tts).toEqual({
      ...setup.tts,
      voice: 'v1',
    });
    expect(changeDirectCall(s, { step: 'sound', sound: { speed: 1.1 } }).tts.sound).toEqual({
      speed: 1.1,
    });
  });
});

describe('kokoroVoiceLabel', () => {
  it('names a voice from Kokoro’s id convention, and leaves any other id as it is', () => {
    expect(kokoroVoiceLabel('af_heart')).toBe('Heart (American F)');
    expect(kokoroVoiceLabel('bm_george')).toBe('George (British M)');
    expect(kokoroVoiceLabel('custom-voice')).toBe('custom-voice');
  });
});
