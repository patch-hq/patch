// Codec round-trip + rejection tests for the @patch/wire/audio subpath.

import { describe, test, expect } from 'vitest';
import {
  AUDIO_EVENT_SCHEMAS,
  decodeAudio,
  encodeAudio,
  validateDeviceIdCoupling,
  DEFAULT_VOICE_CONFIG,
  DictationSetting,
  dictationEngineFor,
  SpeechToTextEngine,
  dictationEnginesFor,
  type AudioEvent,
  type AudioEventType,
  type AudioSessionStartEvent,
} from '../src/audio.js';
import { decode, encode, VoiceConfigSetting, type WireEvent } from '../src/index.js';

const FIXTURES: { [K in AudioEventType]: Extract<AudioEvent, { type: K }> } = {
  'audio.session_start': {
    type: 'audio.session_start',
    sessionId: 'sess1',
    accountId: 'acct1',
    surfaceId: 'surf1',
    surfaceKind: 'web',
    chatId: 'chat1',
    role: 'voice-call',
    token: 'aaaa.bbbb',
    surfaceHasAec: true,
  },
  'audio.session_end': { type: 'audio.session_end', sessionId: 'sess1', reason: 'user' },
  'audio.mode': { type: 'audio.mode', sessionId: 'sess1', mode: 'hands-free' },
  'audio.speak': { type: 'audio.speak', sessionId: 'sess1', text: 'the bus chat is blocked' },
  'audio.dictation_finish': { type: 'audio.dictation_finish', sessionId: 'sess1' },
  'audio.pcm16': { type: 'audio.pcm16', ts: 1, sampleRate: 16000, samples: 480 },
  'audio.transcript_partial': {
    type: 'audio.transcript_partial',
    sessionId: 'sess1',
    text: 'hel',
  },
  'audio.transcript_final': {
    type: 'audio.transcript_final',
    sessionId: 'sess1',
    text: 'hello',
    sttLatencyMs: 200,
  },
  'audio.tts_chunk': {
    type: 'audio.tts_chunk',
    sessionId: 'sess1',
    samples: 240,
    firstFrameLatencyMs: 150,
  },
  'audio.tts_end': { type: 'audio.tts_end', sessionId: 'sess1', bargedIn: false },
  'audio.state': { type: 'audio.state', sessionId: 'sess1', state: 'listening' },
  'audio.barge_in': { type: 'audio.barge_in', sessionId: 'sess1', at: 12345 },
  'audio.error': {
    type: 'audio.error',
    code: 'concurrency_cap',
    message: 'too many sessions',
    sessionId: 'sess1',
  },
  'audio.heartbeat': { type: 'audio.heartbeat', sessionId: 'sess1', n: 4, rttMs: 38 },
  'audio.call_log': {
    type: 'audio.call_log',
    sessionId: 'sess2',
    entries: [
      { kind: 'audio_stopped', at: 1, sessionId: 'sess1', reason: 'connection_closed' },
      {
        kind: 'quality',
        at: 2,
        sessionId: 'sess1',
        heartbeats: 40,
        lost: 3,
        late: 1,
        maxGapMs: 3100,
        rttMs: { min: 20, avg: 31, max: 90 },
      },
      { kind: 'reconnected', at: 3, sessionId: 'sess2', downMs: 4200, attempts: 2 },
      { kind: 'turn', at: 4, sessionId: 'sess2', speechToTextMs: 300, modelMs: 900 },
    ],
  },
  'audio.chat_switched': { type: 'audio.chat_switched', sessionId: 'sess1', chatId: 'chat2' },
  'audio.passed_to_agent': { type: 'audio.passed_to_agent', sessionId: 'sess1' },
};

describe('@patch/wire/audio codec', () => {
  for (const [type, ev] of Object.entries(FIXTURES) as [AudioEventType, AudioEvent][]) {
    test(`round-trips ${type}`, () => {
      expect(decodeAudio(encodeAudio(ev))).toEqual(ev);
    });
  }

  test('AUDIO_EVENT_SCHEMAS catalogues every variant', () => {
    const fixtureKeys = Object.keys(FIXTURES).sort();
    const schemaKeys = Object.keys(AUDIO_EVENT_SCHEMAS).sort();
    expect(fixtureKeys).toEqual(schemaKeys);
  });

  test('strict() rejects unknown fields on session_start', () => {
    const bad = {
      ...FIXTURES['audio.session_start'],
      sneaky: true,
    };
    expect(() => decodeAudio(JSON.stringify(bad))).toThrow();
  });

  test('rejects pcm16 with non-16k/24k sample rate', () => {
    const bad = { type: 'audio.pcm16', ts: 1, sampleRate: 22050, samples: 100 };
    expect(() => decodeAudio(JSON.stringify(bad))).toThrow();
  });

  test('a call log is capped, and its entries are checked', () => {
    const entry = { kind: 'reconnected', at: 1, sessionId: 's', downMs: 1, attempts: 1 };
    const big = { type: 'audio.call_log', sessionId: 's', entries: Array(501).fill(entry) };
    expect(() => decodeAudio(JSON.stringify(big))).toThrow();
    const odd = { type: 'audio.call_log', sessionId: 's', entries: [{ ...entry, kind: 'mood' }] };
    expect(() => decodeAudio(JSON.stringify(odd))).toThrow();
  });

  test('rejects audio.error with unknown code', () => {
    const bad = { type: 'audio.error', code: 'mystery', message: 'x' };
    expect(() => decodeAudio(JSON.stringify(bad))).toThrow();
  });

  test('accepts audio.error with sdk_error code (group 14 DX-M1)', () => {
    const ev = {
      type: 'audio.error' as const,
      code: 'sdk_error' as const,
      message: 'turn failed: SdkAbortError',
      sessionId: 'sess1',
    };
    expect(decodeAudio(encodeAudio(ev))).toEqual(ev);
  });

  test("accepts session_start with surfaceKind: 'device' (B-23 voice device)", () => {
    const ev: AudioEvent = {
      type: 'audio.session_start',
      sessionId: 'sess-dev',
      accountId: 'acct1',
      surfaceId: 'surf-dev',
      surfaceKind: 'device',
      chatId: 'chat1',
      role: 'voice-device-conv',
      token: 'aaaa.bbbb',
      surfaceHasAec: false,
    };
    expect(decodeAudio(encodeAudio(ev))).toEqual(ev);
  });

  test('accepts session_start with optional voiceToken (daemon-pushed, B-23-3)', () => {
    const ev: AudioEvent = {
      type: 'audio.session_start',
      sessionId: 'sess-dev',
      accountId: 'acct1',
      surfaceId: 'surf-dev',
      surfaceKind: 'device',
      chatId: 'chat1',
      role: 'voice-device-conv',
      token: '',
      surfaceHasAec: false,
      voiceToken: 'cccc.dddd',
    };
    const decoded = decodeAudio(encodeAudio(ev));
    expect(decoded).toEqual(ev);
    if (decoded.type !== 'audio.session_start') throw new Error('unexpected variant');
    expect(decoded.voiceToken).toBe('cccc.dddd');
  });

  test("rejects session_start with bad surfaceKind ('fridge')", () => {
    const bad = {
      ...FIXTURES['audio.session_start'],
      surfaceKind: 'fridge',
    };
    expect(() => decodeAudio(JSON.stringify(bad))).toThrow();
  });

  test('rejects session_start with non-string voiceToken', () => {
    const bad = {
      ...FIXTURES['audio.session_start'],
      voiceToken: 123,
    };
    expect(() => decodeAudio(JSON.stringify(bad))).toThrow();
  });

  test('decodeAudio accepts a Uint8Array frame', () => {
    const ev = FIXTURES['audio.session_end'];
    const bytes = new TextEncoder().encode(encodeAudio(ev));
    expect(decodeAudio(bytes)).toEqual(ev);
  });

  test('decodeAudio accepts an ArrayBuffer frame', () => {
    const ev = FIXTURES['audio.session_end'];
    const bytes = new TextEncoder().encode(encodeAudio(ev));
    // Slice to a plain ArrayBuffer (not a Uint8Array) to hit that branch.
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    expect(decodeAudio(buf)).toEqual(ev);
  });

  test('decodeAudio throws on an unsupported frame type', () => {
    expect(() => decodeAudio(12345 as unknown as string)).toThrow(
      'decodeAudio: unsupported frame type',
    );
  });
});

describe('validateDeviceIdCoupling', () => {
  const base: AudioSessionStartEvent = {
    type: 'audio.session_start',
    sessionId: 'sess1',
    accountId: 'acct1',
    surfaceId: 'surf1',
    surfaceKind: 'web',
    chatId: 'chat1',
    role: 'voice-call',
    token: 'aaaa.bbbb',
    surfaceHasAec: true,
  };

  test('returns null when a device session carries a deviceId', () => {
    const start: AudioSessionStartEvent = { ...base, surfaceKind: 'device', deviceId: 'kitchen' };
    expect(validateDeviceIdCoupling(start)).toBeNull();
  });

  test('returns null when a non-device session has no deviceId', () => {
    expect(validateDeviceIdCoupling(base)).toBeNull();
  });

  test('errors when a device session is missing deviceId', () => {
    const start: AudioSessionStartEvent = { ...base, surfaceKind: 'device' };
    expect(validateDeviceIdCoupling(start)).toBe(
      "deviceId is required when surfaceKind === 'device'",
    );
  });

  test('errors when a non-device session carries a deviceId', () => {
    const start: AudioSessionStartEvent = { ...base, deviceId: 'kitchen' };
    expect(validateDeviceIdCoupling(start)).toBe(
      "deviceId is only valid when surfaceKind === 'device'",
    );
  });
});

describe('chat.input.source — voice-app discriminator (group 13)', () => {
  test('round-trips with voice-app source', () => {
    const ev: WireEvent = {
      type: 'chat.input',
      chatId: 'thread_speakers',
      message: 'turn the lights off',
      localId: 'lid-va-1',
      source: { kind: 'voice-app', surfaceKind: 'mobile', sessionId: 'sess-x' },
    };
    expect(decode(encode(ev))).toEqual(ev);
  });

  test('rejects voice-app source missing surfaceKind', () => {
    const bad = {
      type: 'chat.input',
      chatId: 'c1',
      message: 'hi',
      localId: 'l',
      source: { kind: 'voice-app', sessionId: 's' },
    };
    expect(() => decode(JSON.stringify(bad))).toThrow();
  });

  test('rejects voice-app source with bad surfaceKind', () => {
    const bad = {
      type: 'chat.input',
      chatId: 'c1',
      message: 'hi',
      localId: 'l',
      source: { kind: 'voice-app', surfaceKind: 'fridge', sessionId: 's' },
    };
    expect(() => decode(JSON.stringify(bad))).toThrow();
  });
});

describe('speech to text setting', () => {
  test('defaults to Groq Whisper, and an older saved voice config reads as Groq', () => {
    expect(DEFAULT_VOICE_CONFIG.speechToText).toBe('groq');
    const { speechToText: _omitted, ...old } = DEFAULT_VOICE_CONFIG;
    expect(VoiceConfigSetting.parse(old).speechToText).toBe('groq');
  });
  test('offers exactly the four engines and rejects any other', () => {
    expect(SpeechToTextEngine.options).toEqual(['groq', 'whisper', 'parakeet', 'elevenlabs']);
    expect(() =>
      VoiceConfigSetting.parse({ ...DEFAULT_VOICE_CONFIG, speechToText: 'deepgram' }),
    ).toThrow();
  });
});

describe('the dictation setting (spec/07 § Dictation engines)', () => {
  test('the phone app runs the phone engine; web and desktop run the computer one', () => {
    const d = { phone: 'device', computer: 'deepgram', tidy: true } as const;
    expect(dictationEngineFor(d, 'mobile')).toBe('device');
    expect(dictationEngineFor(d, 'web')).toBe('deepgram');
    expect(dictationEngineFor(d, 'desktop')).toBe('deepgram');
  });

  test('a computer can run Parakeet itself, a phone cannot', () => {
    expect(DictationSetting.parse({ phone: 'whisper', computer: 'local', tidy: false })).toEqual({
      phone: 'whisper',
      computer: 'local',
      tidy: false,
    });
    expect(() =>
      DictationSetting.parse({ phone: 'local', computer: 'whisper', tidy: false }),
    ).toThrow();
  });

  test('a computer has no recogniser of its own', () => {
    expect(() =>
      DictationSetting.parse({ phone: 'whisper', computer: 'device', tidy: false }),
    ).toThrow();
  });

  test('a setting saved before the phone and computer had their own engines still reads', () => {
    expect(DictationSetting.parse({ backend: 'deepgram', phone: false, tidy: true })).toEqual({
      phone: 'deepgram',
      computer: 'deepgram',
      tidy: true,
    });
    // The phone recogniser switch becomes the phone's Built-in engine.
    expect(DictationSetting.parse({ backend: 'deepgram', phone: true, tidy: false })).toEqual({
      phone: 'device',
      computer: 'deepgram',
      tidy: false,
    });
    // The retired hosted transcribers become the host's Whisper.
    for (const backend of ['local', 'gemini', 'openai']) {
      expect(DictationSetting.parse({ backend })).toEqual({
        phone: 'whisper',
        computer: 'whisper',
        tidy: false,
      });
    }
  });
});

describe('meeting engine', () => {
  test('is part of the voice config and defaults to local', async () => {
    const { DEFAULT_VOICE_CONFIG, MeetingEngine } = await import('../src/audio.js');
    expect(DEFAULT_VOICE_CONFIG.meeting).toBe('local');
    expect(MeetingEngine.options).toEqual(['local', 'elevenlabs', 'deepgram', 'assemblyai']);
  });
});

describe('dictationEngineFor — each device picks its own engine', () => {
  const dictation = { phone: 'device', computer: 'whisper', tidy: false } as const;
  test('a device with its own choice runs on it; one without runs on its kind’s engine', () => {
    const deviceDictation = { mac: 'local', pixel: 'deepgram' } as const;
    expect(dictationEngineFor(dictation, 'desktop', { surfaceId: 'mac', deviceDictation })).toBe(
      'local',
    );
    expect(dictationEngineFor(dictation, 'mobile', { surfaceId: 'pixel', deviceDictation })).toBe(
      'deepgram',
    );
    expect(dictationEngineFor(dictation, 'mobile', { surfaceId: 'other', deviceDictation })).toBe(
      'device',
    );
    expect(dictationEngineFor(dictation, 'web')).toBe('whisper');
  });
  test('a choice the device cannot run is refused, never swapped', () => {
    expect(() =>
      dictationEngineFor(dictation, 'web', { surfaceId: 'b', deviceDictation: { b: 'local' } }),
    ).toThrow(/does not run on a browser/);
    expect(() =>
      dictationEngineFor(dictation, 'desktop', {
        surfaceId: 'm',
        deviceDictation: { m: 'device' },
      }),
    ).toThrow(/does not run on a computer/);
  });
  test('each kind is offered only what it can run', () => {
    expect(dictationEnginesFor('mobile')).toContain('device');
    expect(dictationEnginesFor('mobile')).not.toContain('local');
    expect(dictationEnginesFor('desktop')).toContain('local');
    expect(dictationEnginesFor('web')).not.toContain('local');
  });
});
