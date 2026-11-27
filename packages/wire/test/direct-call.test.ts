import { describe, expect, it } from 'vitest';
import {
  agentWorkingLabel,
  cloudSpeechEngines,
  directCallSummary,
  NO_SPEECH_ENGINE,
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
    expect(resolveDirectCall({ stt: [], tts: [] }, undefined)).toEqual({
      ok: false,
      reason: NO_SPEECH_ENGINE,
    });
    expect(resolveDirectCall({ stt: desktop.stt, tts: [] }, undefined)).toEqual({
      ok: false,
      reason: NO_SPEECH_ENGINE,
    });
  });

  it('engines this build does not know do not count', () => {
    const r = resolveDirectCall(
      { stt: [{ engine: 'future', where: 'cloud', models: ['x'] }], tts: desktop.tts },
      undefined,
    );
    expect(r).toEqual({ ok: false, reason: NO_SPEECH_ENGINE });
  });

  it('with no setup chosen, runs on-device engines first', () => {
    const r = resolveDirectCall(desktop, undefined);
    expect(r.ok && r.call).toEqual({
      stt: { engine: 'parakeet', where: 'device', model: 'parakeet-tdt-0.6b-v3' },
      tts: { engine: 'kokoro', where: 'device', model: 'kokoro-82m', voice: 'af_heart', sound: {} },
    });
    expect(r.ok && directCallSummary(r.call)).toBe('Parakeet → Kokoro');
  });

  it('runs the chosen setup with only that engine’s sound controls', () => {
    const r = resolveDirectCall(desktop, {
      stt: { engine: 'groq' },
      tts: {
        engine: 'elevenlabs',
        voice: 'v2',
        sound: { stability: 0.7, speed: 0.95, tone: 'calm' },
      },
    });
    expect(r.ok && r.call.tts).toEqual({
      engine: 'elevenlabs',
      where: 'cloud',
      model: 'eleven_flash_v2_5',
      voice: 'v2',
      sound: { stability: 0.7, speed: 0.95, tone: 'calm' },
    });
    const k = resolveDirectCall(desktop, {
      stt: { engine: 'parakeet' },
      tts: { engine: 'kokoro', sound: { stability: 0.2, speed: 1.1 } },
    });
    expect(k.ok && k.call.tts.sound).toEqual({ speed: 1.1 });
  });

  it('refuses an engine the device does not report, naming it, never swapping', () => {
    const r = resolveDirectCall(desktop, { stt: { engine: 'android' }, tts: { engine: 'kokoro' } });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/speech to text is set to Android, which it does not have/);
    const t = resolveDirectCall(desktop, { stt: { engine: 'groq' }, tts: { engine: 'openai' } });
    expect(!t.ok && t.reason).toMatch(/text to speech is set to OpenAI/);
  });

  it('a cloud voice engine with no voice listed is refused', () => {
    const r = resolveDirectCall(
      {
        stt: desktop.stt,
        tts: [{ engine: 'elevenlabs', where: 'cloud', models: ['m'], voices: [] }],
      },
      undefined,
    );
    expect(!r.ok && r.reason).toMatch(/ElevenLabs has no voice/);
  });
});

describe('cloudSpeechEngines', () => {
  it('offers each cloud engine the account holds a key for', () => {
    expect(cloudSpeechEngines(new Set(), [])).toEqual({ stt: [], tts: [] });
    const r = cloudSpeechEngines(new Set(['groq', 'elevenlabs', 'openai', 'gemini']), ['v1']);
    expect(r.stt.map((e) => e.engine)).toEqual(['groq', 'elevenlabs']);
    expect(r.tts.map((e) => e.engine)).toEqual(['elevenlabs', 'openai']);
    expect(r.tts[0]!.voices).toEqual(['v1']);
    expect(r.stt.every((e) => e.where === 'cloud')).toBe(true);
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
  it('counts a key any host holds, and gathers ElevenLabs voices once', async () => {
    const { cloudSpeechEnginesFromHosts, mergeSpeechEngines } =
      await import('../src/direct-call.js');
    const r = cloudSpeechEnginesFromHosts([
      {
        providerKeys: [
          { id: 'groq', source: 'none' },
          { id: 'openai', source: 'env' },
        ],
      },
      {
        providerKeys: [{ id: 'elevenlabs', source: 'ui' }],
        elevenLabsVoices: [{ id: 'v1' }, { id: 'v2' }],
      },
      { elevenLabsVoices: [{ id: 'v1' }] },
    ]);
    expect(r.stt.map((e) => e.engine)).toEqual(['elevenlabs']);
    expect(r.tts.map((e) => [e.engine, e.voices])).toEqual([
      ['elevenlabs', ['v1', 'v2']],
      ['openai', expect.arrayContaining(['coral'])],
    ]);
    const merged = mergeSpeechEngines(
      { stt: [{ engine: 'parakeet', where: 'device', models: ['p'] }], tts: [] },
      r,
    );
    expect(merged.stt.map((e) => e.engine)).toEqual(['parakeet', 'elevenlabs']);
  });
});
