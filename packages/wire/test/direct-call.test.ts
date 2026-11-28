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

const phone: SpeechEngineReport = {
  stt: [
    { engine: 'android', where: 'device', models: ['on-device'] },
    { engine: 'groq', where: 'cloud', models: ['whisper-large-v3-turbo'] },
  ],
  tts: [
    { engine: 'android', where: 'device', models: ['default'], voices: ['en-gb-x-1'] },
    { engine: 'elevenlabs', where: 'cloud', models: ['eleven_flash_v2_5'], voices: ['v1', 'v2'] },
  ],
};
const browser: SpeechEngineReport = { stt: [desktop.stt[0]!], tts: [desktop.tts[0]!] };
const CLOUD = {
  stt: { engine: 'groq' as const, model: 'whisper-large-v3-turbo' },
  tts: { engine: 'elevenlabs' as const, model: 'eleven_flash_v2_5', voice: 'v2' },
};
const ON_DEVICE = { stt: { engine: 'device' as const }, tts: { engine: 'device' as const } };

describe('resolveDirectCall', () => {
  it('a device with no engine for a step has No speech engine', () => {
    expect(resolveDirectCall({ stt: [], tts: [] }, CLOUD, {})).toEqual({
      ok: false,
      reason: NO_SPEECH_ENGINE,
      settings: false,
    });
  });

  it('nothing picked: nothing is chosen for the user, and the fix is in Settings', () => {
    for (const setup of [undefined, { stt: CLOUD.stt }]) {
      expect(resolveDirectCall(desktop, setup, {})).toEqual({
        ok: false,
        reason: NOT_SET_UP,
        settings: true,
      });
    }
    // A cloud step with its model or voice still to pick is not finished either.
    expect(
      resolveDirectCall(desktop, { stt: { engine: 'groq' }, tts: CLOUD.tts }, {}),
    ).toMatchObject({ ok: false, reason: NOT_SET_UP });
  });

  it('one cloud setup runs the same on every device', () => {
    for (const report of [desktop, phone, browser]) {
      const r = resolveDirectCall(report, CLOUD, {});
      expect(r.ok && directCallSummary(r.call)).toBe('Groq Whisper → ElevenLabs');
    }
  });

  it('On device runs each device’s own engine, model and voice', () => {
    const mac = resolveDirectCall(desktop, ON_DEVICE, {});
    expect(mac.ok && mac.call.stt).toEqual({
      engine: 'parakeet',
      where: 'device',
      model: 'parakeet-tdt-0.6b-v3',
    });
    expect(mac.ok && mac.call.tts).toMatchObject({ engine: 'kokoro', voice: 'af_heart' });
    const p = resolveDirectCall(phone, ON_DEVICE, {});
    expect(p.ok && directCallSummary(p.call)).toBe('Android → Android');
    // Mixed: hear on device, speak in the cloud.
    const m = resolveDirectCall(phone, { stt: { engine: 'device' }, tts: CLOUD.tts }, {});
    expect(m.ok && directCallSummary(m.call)).toBe('Android → ElevenLabs');
  });

  it('On device on a device with none of its own is refused with the fix, never swapped', () => {
    const r = resolveDirectCall(browser, ON_DEVICE, {});
    expect(r).toEqual({
      ok: false,
      reason: expect.stringMatching(/hear you on device, and this device has no speech to text/),
      settings: true,
    });
  });

  it('a cloud engine no host has a key for is refused, naming it', () => {
    const r = resolveDirectCall({ stt: desktop.stt, tts: [desktop.tts[1]!] }, CLOUD, {});
    expect(!r.ok && r.reason).toMatch(/speak with ElevenLabs, which has no key on any host/);
  });

  it('runs the saved setup: the engine’s controls, stored or default, and the voice’s tone', () => {
    const r = resolveDirectCall(
      desktop,
      { stt: CLOUD.stt, tts: { ...CLOUD.tts, sound: { stability: 0.5 } } },
      { 'elevenlabs:v2': 'calm', 'elevenlabs:v1': 'brisk' },
    );
    expect(r.ok && r.call.tts).toEqual({
      engine: 'elevenlabs',
      where: 'cloud',
      model: 'eleven_flash_v2_5',
      voice: 'v2',
      sound: { stability: 0.5, similarity: 0.8, style: 0, speed: 0.95, tone: 'calm' },
    });
    // A model or voice the provider no longer lists is refused, naming it.
    const gone = resolveDirectCall(
      desktop,
      { stt: { engine: 'groq', model: 'whisper-old' }, tts: CLOUD.tts },
      {},
    );
    expect(!gone.ok && gone.reason).toMatch(/no longer has the model whisper-old/);
  });

  it('a stored setup must fit: sound to its engine, nothing extra on device', () => {
    expect(
      DirectCallSetup.safeParse({
        stt: { engine: 'groq' },
        tts: { engine: 'openai', sound: { stability: 0.2 } },
      }).success,
    ).toBe(false);
    expect(
      DirectCallSetup.safeParse({
        stt: { engine: 'groq' },
        tts: { engine: 'openai', sound: { speed: 2 } },
      }).success,
    ).toBe(true);
    expect(
      DirectCallSetup.safeParse({
        stt: { engine: 'device' },
        tts: { engine: 'device', voice: 'x' },
      }).success,
    ).toBe(false);
    // A device engine by name is not a choice: On device is.
    expect(
      DirectCallSetup.safeParse({ stt: { engine: 'parakeet' }, tts: { engine: 'device' } }).success,
    ).toBe(false);
  });

  it('a cloud voice engine with no voice listed is refused', () => {
    const r = resolveDirectCall(
      {
        stt: desktop.stt,
        tts: [{ engine: 'elevenlabs', where: 'cloud', models: ['m'], voices: [] }],
      },
      { stt: CLOUD.stt, tts: { engine: 'elevenlabs', model: 'm' } },
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
    const setup = { stt: CLOUD.stt, tts: { engine: 'device' as const } };
    expect(resolveDirectCall(report, setup, {})).toEqual({
      ok: false,
      reason: 'Groq Whisper: the model list could not be read (box: HTTP 401).',
      settings: true,
    });
    // Settings shows the list's own line at the step, so the setup's problem is not repeated.
    expect(directCallSteps(report, setup, {}).problem).toBeUndefined();
  });
});

describe('Settings steps (directCallSteps / changeDirectCall)', () => {
  it('offers On device and every cloud engine with a key; nothing is chosen until picked', () => {
    const s = directCallSteps(desktop, undefined, {});
    expect(s.stt.options).toEqual([
      { engine: 'device', label: 'On device', where: 'device' },
      { engine: 'groq', label: 'Groq Whisper', where: 'cloud' },
    ]);
    expect(s.tts.options.map((o) => o.engine)).toEqual(['device', 'elevenlabs']);
    expect(s.stt.engine).toBeUndefined();
    expect(s.tts.engine).toBeUndefined();
    expect(s.summary).toBe('Set up');
    expect(s.problem).toBeUndefined();
  });

  it('says what this device runs, or why it cannot', () => {
    expect(directCallSteps(phone, ON_DEVICE, {}).summary).toBe('Android → Android');
    const b = directCallSteps(browser, ON_DEVICE, {});
    expect(b.summary).toBe('Set up');
    expect(b.problem).toMatch(/no speech to text of its own/);
  });

  it('a cloud step offers its provider’s models and voices; On device offers none', () => {
    const s = directCallSteps(desktop, CLOUD, {});
    expect(s.sttModel.options).toEqual(['whisper-large-v3-turbo']);
    expect(s.voice.options).toEqual(['v1', 'v2']);
    const d = directCallSteps(desktop, ON_DEVICE, {});
    expect(d.sttModel.options).toEqual([]);
    expect(d.voice.options).toEqual([]);
  });

  it('a changed engine starts its own model, voice and sound over and keeps the other step', () => {
    const setup = { stt: CLOUD.stt, tts: { ...CLOUD.tts, sound: { stability: 0.4 } } };
    const s = directCallSteps(desktop, setup, {});
    expect(changeDirectCall(s, { step: 'tts', engine: 'device' })).toEqual({
      stt: setup.stt,
      tts: { engine: 'device' },
    });
    expect(changeDirectCall(s, { step: 'stt', engine: 'device' })).toEqual({
      stt: { engine: 'device' },
      tts: setup.tts,
    });
    expect(changeDirectCall(s, { step: 'sttModel', model: 'whisper-large-v3' })).toEqual({
      stt: { engine: 'groq', model: 'whisper-large-v3' },
      tts: setup.tts,
    });
    expect(changeDirectCall(s, { step: 'voice', voice: 'v1' }).tts).toEqual({
      ...setup.tts,
      voice: 'v1',
    });
    expect(changeDirectCall(s, { step: 'sound', sound: { speed: 1.1 } }).tts?.sound).toEqual({
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
