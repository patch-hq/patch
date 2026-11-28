// spec/07 § Call cost.

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callSummaryLine,
  costCall,
  costDirectCall,
  ELEVENLABS_USD_PER_CREDIT,
  engineCostUsd,
  formatUsd,
  ZERO_TOKENS,
  type EngineCosting,
} from '../src/audio/voiceCost.js';
import { createVoiceLedger } from '../src/audio/voiceLedger.js';

const base = {
  sessionId: 's1',
  chatId: 'c1',
  surfaceKind: 'desktop',
  startedAt: Date.UTC(2026, 9, 4, 11, 0, 0),
  endedAt: Date.UTC(2026, 9, 4, 11, 0, 52),
};

describe('engine pricing', () => {
  it('prices Gemini Flash audio and text tokens per million', () => {
    const usd = engineCostUsd('models/gemini-2.5-flash-native-audio-preview-12-2025', {
      ...ZERO_TOKENS,
      audioIn: 1_000_000,
      audioOut: 1_000_000,
      textIn: 1_000_000,
    });
    expect(usd).toBeCloseTo(3 + 12 + 0.5, 6);
  });

  it('prices OpenAI realtime mini, including cached input', () => {
    const usd = engineCostUsd('gpt-realtime-2.1-mini', {
      ...ZERO_TOKENS,
      audioIn: 1_000_000,
      cachedIn: 1_000_000,
      audioOut: 1_000_000,
    });
    expect(usd).toBeCloseTo(10 + 0.3 + 20, 6);
  });

  it('returns null for a model with no published price, never a guess', () => {
    expect(engineCostUsd('models/gemini-made-up', { ...ZERO_TOKENS, audioIn: 5 })).toBeNull();
  });
});

describe('costing a call', () => {
  const gemini: EngineCosting = {
    backend: 'gemini',
    model: 'models/gemini-2.5-flash-native-audio-preview-12-2025',
    tokens: { ...ZERO_TOKENS, audioIn: 3000, textIn: 2000, audioOut: 600 },
    stt: null,
  };

  it('summarises engine, length and tokens on one line, with no agent cost on it', () => {
    const c = costCall({ ...base, engine: gemini, handoffs: 0 });
    expect(c.engineUsd).toBeCloseTo((3000 * 3 + 2000 * 0.5 + 600 * 12) / 1e6, 9);
    expect(callSummaryLine(c)).toBe(
      'Call 0:52 · Gemini Flash · $0.017 · 5,000 tokens in / 600 out',
    );
  });

  it('leaves tokens out rather than printing 0 or a not-reported note', () => {
    const c = costCall({ ...base, engine: { ...gemini, tokens: { ...ZERO_TOKENS } }, handoffs: 0 });
    const line = callSummaryLine(c);
    expect(line).not.toContain('0 tokens in');
    expect(line).not.toContain('token');
  });

  it('leaves the price out for an unpriced model', () => {
    const c = costCall({
      ...base,
      engine: { ...gemini, model: 'models/gemini-made-up' },
      handoffs: 0,
    });
    expect(c.engineUsd).toBeNull();
    expect(callSummaryLine(c)).not.toMatch(/unknown|\$/);
  });

  it('costs local STT at Groq rates with the 10s minimum per request', () => {
    const c = costCall({
      ...base,
      engine: {
        backend: 'local',
        model: 'whisper-large-v3-turbo',
        tokens: null,
        stt: { requests: 3, audioSeconds: 7, billedSeconds: 30 },
      },
      handoffs: 0,
    });
    expect(c.engineUsd).toBeCloseTo((30 * 0.04) / 3600, 9);
    expect(callSummaryLine(c)).toBe('Call 0:52 · Local · $0.00033');
  });

  it('prices each speech to text model at its own rate; one not in the table has no price', () => {
    const stt = { requests: 1, audioSeconds: 3600, billedSeconds: 3600 };
    const cost = (model: string) =>
      costCall({ ...base, engine: { backend: 'local', model, tokens: null, stt }, handoffs: 0 })
        .engineUsd;
    expect(cost('whisper-large-v3')).toBeCloseTo(0.111, 9);
    expect(cost('whisper-large-v3-turbo')).toBeCloseTo(0.04, 9);
    expect(cost('nova-3')).toBeNull();
    expect(cost('scribe_v2')).toBeNull();
  });
});

describe('a direct call', () => {
  const end = (usage: Parameters<typeof costDirectCall>[0]['usage']) =>
    costDirectCall({ ...base, sessionId: 'dc-1', usage });

  it('prices what its cloud engines were sent: Groq per request with the 10 s minimum, ElevenLabs per character', () => {
    const c = end({
      stt: { engine: 'groq', model: 'whisper-large-v3-turbo', utteranceSeconds: [2, 30] },
      tts: { engine: 'elevenlabs', model: 'eleven_flash_v2_5', requests: 2, characters: 600 },
    });
    expect(c.backend).toBe('direct');
    expect(c.direct?.stt).toMatchObject({ requests: 2, audioSeconds: 32, billedSeconds: 40 });
    const want = (40 * 0.04) / 3600 + 600 * 0.5 * ELEVENLABS_USD_PER_CREDIT;
    expect(c.engineUsd).toBeCloseTo(want, 9);
    expect(callSummaryLine(c)).toBe(`Call 0:52 · Groq Whisper → ElevenLabs · ${formatUsd(want)}`);
  });

  it('costs nothing on the device’s own engines, and still leaves its line', () => {
    const c = end({
      stt: { engine: 'parakeet', model: 'parakeet-tdt-0.6b-v3', utteranceSeconds: [] },
      tts: { engine: 'kokoro', model: 'kokoro-82m', requests: 0, characters: 0 },
    });
    expect(c.engineUsd).toBe(0);
    expect(callSummaryLine(c)).toBe('Call 0:52 · Parakeet → Kokoro · $0');
  });

  it('a cloud engine with no price here leaves the price off rather than guessing', () => {
    const c = end({
      stt: { engine: 'elevenlabs', model: 'scribe_v2', utteranceSeconds: [4] },
      tts: { engine: 'openai', model: 'tts-1', requests: 1, characters: 10 },
    });
    expect(c.engineUsd).toBeNull();
    expect(callSummaryLine(c)).toBe('Call 0:52 · ElevenLabs Scribe → OpenAI');
  });

  it('counts on the ledger: a call, its dollars, and ElevenLabs credits for its speech', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'patch-ledger-')), 'voice-usage.jsonl');
    const ledger = createVoiceLedger(path);
    ledger.record(
      end({
        stt: { engine: 'android', model: 'on-device', utteranceSeconds: [] },
        tts: {
          engine: 'elevenlabs',
          model: 'eleven_multilingual_v2',
          requests: 3,
          characters: 900,
        },
      }),
    );
    const t = createVoiceLedger(path).totals(base.endedAt);
    expect(t.monthCalls).toBe(1);
    expect(t.monthCredits).toBe(900);
    expect(t.monthUsd).toBeCloseTo(900 * ELEVENLABS_USD_PER_CREDIT, 9);
  });
});

describe('voice ledger', () => {
  it("keeps every call on disk and totals this month's and all-time spend", () => {
    const path = join(mkdtempSync(join(tmpdir(), 'patch-ledger-')), 'voice-usage.jsonl');
    const ledger = createVoiceLedger(path);
    // 9000 billed seconds of Groq STT at $0.04 per hour is $0.10 a call.
    const engine: EngineCosting = {
      backend: 'local',
      model: 'whisper-large-v3-turbo',
      tokens: null,
      stt: { requests: 1, audioSeconds: 10, billedSeconds: 9000 },
    };
    ledger.record(costCall({ ...base, engine }));
    ledger.record(
      costCall({
        ...base,
        startedAt: Date.UTC(2026, 8, 1),
        endedAt: Date.UTC(2026, 8, 1, 0, 1),
        engine,
      }),
    );

    const reopened = createVoiceLedger(path);
    const t = reopened.totals(Date.UTC(2026, 9, 20));
    expect(t.allCalls).toBe(2);
    expect(t.monthCalls).toBe(1);
    expect(t.allUsd).toBeCloseTo(0.2, 9);
    expect(t.monthUsd).toBeCloseTo(0.1, 9);
  });

  it('totals tokens and ElevenLabs credits in the providers’ own units', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'patch-ledger-')), 'voice-usage.jsonl');
    const ledger = createVoiceLedger(path);
    ledger.record(
      costCall({
        ...base,
        engine: {
          backend: 'gemini',
          model: 'x',
          tokens: { textIn: 100, audioIn: 400, cachedIn: 50, textOut: 20, audioOut: 300 },
          stt: null,
        },
      }),
    );
    ledger.record({
      ...costCall({
        ...base,
        engine: { backend: 'elevenlabs', model: 'x', tokens: null, stt: null },
      }),
      real: { credits: 2923, usd: null, creditsLeft: 144271 },
    });
    ledger.recordSpeech({
      kind: 'tts',
      provider: 'elevenlabs',
      model: 'eleven_flash_v2_5',
      characters: 200,
      at: base.endedAt,
      usd: null,
    });
    const t = createVoiceLedger(path).totals(base.endedAt);
    expect(t.monthTokens).toBe(870);
    expect(t.allTokens).toBe(870);
    // 2923 for the call, plus 200 characters of Flash at half a credit each.
    expect(t.monthCredits).toBe(3023);
    expect(t.allCalls).toBe(2);
  });
});

describe('formatUsd — amounts too small for plain digits', () => {
  it('never prints scientific notation', () => {
    expect(formatUsd(5e-7)).toBe('$0.0000005');
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(0.05)).toBe('$0.05');
    expect(formatUsd(1.234)).toBe('$1.23');
    expect(formatUsd(0)).toBe('$0');
  });
});

describe('ElevenLabs Agents', () => {
  const engine: EngineCosting = {
    backend: 'elevenlabs',
    model: 'claude-haiku-4-5',
    tokens: ZERO_TOKENS,
    stt: null,
    agentSeconds: 52,
    conversationId: 'conv_1',
  };

  it('has no written-down dollar rate: the price comes from ElevenLabs', () => {
    const c = costCall({ ...base, engine, handoffs: 1 });
    expect(c.engineUsd).toBeNull();
    expect(c.conversationId).toBe('conv_1');
    expect(callSummaryLine(c)).toContain('cost not checked');
  });

  it('shows credits and credits left, and no dollars on a plan', () => {
    const c = costCall({ ...base, engine, handoffs: 1 });
    c.real = { credits: 1616, usd: null, creditsLeft: 82000 };
    const line = callSummaryLine(c);
    expect(line).toContain('ElevenLabs Haiku · 1,616 credits · 82,000 left this month');
    expect(line).not.toContain('$');
  });

  it('shows dollars only when paid by usage, and counts them in the ledger', () => {
    const c = costCall({ ...base, engine, handoffs: 1 });
    c.real = { credits: 1616, usd: 0.29, creditsLeft: 0 };
    expect(callSummaryLine(c)).toContain('$0.29');
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const ledger = createVoiceLedger(join(dir, 'u.jsonl'));
    ledger.record(c);
    expect(createVoiceLedger(join(dir, 'u.jsonl')).totals(base.endedAt).allUsd).toBeCloseTo(0.29);
  });

  it('leaves credits left out when unknown, and says when the charge could not be read', () => {
    const c = costCall({ ...base, engine, handoffs: 0 });
    c.real = { credits: 100, usd: null, creditsLeft: null };
    expect(callSummaryLine(c)).not.toContain('unknown');
    c.real = { error: 'HTTP 401' };
    expect(callSummaryLine(c)).toContain('cost unavailable');
  });
});
