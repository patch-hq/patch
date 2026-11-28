import { describe, expect, test } from 'vitest';
import {
  DEFAULT_VOICE_AGENT,
  DEFAULT_VOICE_CONFIG,
  engineSetupLine,
  gapsFor,
  hostGaps,
  keyMissingGap,
  needsFor,
  refusalMessage,
  type VoiceHostFacts,
  type VoiceSetup,
} from '../src/audio.js';

const setup: VoiceSetup = {
  config: DEFAULT_VOICE_CONFIG,
  agent: DEFAULT_VOICE_AGENT,
  ttsBackend: 'kokoro',
};
const ready: VoiceHostFacts = {
  hostName: 'the Mac',
  voiceKeys: { gemini: true, openai: true, groq: true, elevenlabs: true, deepgram: true },
  localEngines: { whisper: true, parakeet: true, kokoro: true },
};

describe('voice readiness', () => {
  test('a spoken alert needs only speech: never speech to text or the microphone', () => {
    expect(needsFor({ feature: 'spoken-alert' }, setup)).toEqual([
      { kind: 'engine', engine: 'kokoro', role: 'speech' },
    ]);
    const noStt: VoiceHostFacts = {
      ...ready,
      voiceKeys: { ...ready.voiceKeys, groq: false },
      localEngines: { whisper: false, parakeet: false, kokoro: true },
    };
    expect(gapsFor({ feature: 'spoken-alert' }, setup, noStt, { mic: false })).toEqual([]);
  });

  test('a spoken alert with no speech voice is an invitation naming the fix', () => {
    const noVoice = { ...ready, localEngines: { ...ready.localEngines, kokoro: false } };
    const [gap] = gapsFor({ feature: 'spoken-alert' }, setup, noVoice);
    expect(gap).toMatchObject({
      code: 'kokoro_unavailable',
      message: 'Spoken alerts need a speech voice on the Mac.',
      fix: { page: 'hosts', row: 'component:kokoro' },
    });
    expect(refusalMessage(gap!)).toBe(
      'Spoken alerts need a speech voice on the Mac. Set it up in Settings → Hosts → Components.',
    );
  });

  test('speech on ElevenLabs needs its key instead', () => {
    const el = { ...setup, ttsBackend: 'elevenlabs' as const };
    const noKey = { ...ready, voiceKeys: { ...ready.voiceKeys, elevenlabs: false } };
    expect(gapsFor({ feature: 'spoken-alert' }, el, noKey)[0]).toMatchObject({
      code: 'voice_key_missing',
      fix: { page: 'providers', row: 'key:elevenlabs' },
    });
  });

  test('a call with a missing provider key reports it, with the engines that would work', () => {
    const noGemini = { ...ready, voiceKeys: { ...ready.voiceKeys, gemini: false } };
    expect(gapsFor({ feature: 'call', surface: 'call' }, setup, noGemini)[0]).toMatchObject({
      code: 'voice_key_missing',
      message: 'Calls need a Gemini key on the Mac.',
    });
    const direct = { ...setup, config: { ...setup.config, speechToText: 'groq' as const } };
    const noGroq = {
      ...ready,
      voiceKeys: { ...ready.voiceKeys, groq: false },
      localEngines: { whisper: true, parakeet: false, kokoro: true },
    };
    const [gap] = gapsFor({ feature: 'call', surface: 'device' }, direct, noGroq);
    expect(gap).toMatchObject({
      code: 'whisper_unavailable',
      alternatives: ['whisper', 'elevenlabs'],
    });
  });

  test('device facts add the microphone and notifications', () => {
    const gaps = gapsFor({ feature: 'call', surface: 'call' }, setup, ready, {
      mic: false,
      notifications: false,
    });
    expect(gaps.map((g) => g.code)).toEqual(['device_not_ready', 'device_not_ready']);
    expect(gaps[0]!.fix).toBeNull();
  });

  test('the host boot list is the same evaluation', () => {
    const noKeys = { ...ready, voiceKeys: { gemini: false, openai: false, groq: true } };
    expect(hostGaps(setup, noKeys).map((g) => g.feature.feature)).toEqual(['call', 'call']);
  });

  test('Settings names each host that lacks a key; unreported hosts say nothing', () => {
    const need = { kind: 'key', provider: 'gemini', role: 'agent' } as const;
    expect(
      engineSetupLine(need, [
        { hostName: 'hetzner', voiceKeys: { gemini: false, openai: false, groq: false } },
        { hostName: 'old' },
      ]),
    ).toBe('Needs a Gemini key on hetzner.');
    expect(
      keyMissingGap({ feature: 'meeting', engine: 'assemblyai' }, 'assemblyai', 'h').message,
    ).toBe('Meetings need an AssemblyAI key on h.');
  });
});
