// spec/07 § Call cost.

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callSummaryLine,
  costCall,
  engineCostUsd,
  elevenLabsCostUsd,
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
      'Call 0:52 · Gemini Flash · $0.017 · 5,000 tokens in / 600 out · 0 hand-offs',
    );
  });

  it('says price unknown for an unpriced model', () => {
    const c = costCall({
      ...base,
      engine: { ...gemini, model: 'models/gemini-made-up' },
      handoffs: 0,
    });
    expect(c.engineUsd).toBeNull();
    expect(callSummaryLine(c)).toContain('price unknown');
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
});

describe('voice ledger', () => {
  it("keeps every call on disk and totals this month's and all-time spend", () => {
    const path = join(mkdtempSync(join(tmpdir(), 'patch-ledger-')), 'voice-usage.jsonl');
    const ledger = createVoiceLedger(path);
    // 9000 billed seconds of Groq STT at $0.04 per hour is $0.10 a call.
    const engine: EngineCosting = {
      backend: 'local',
      model: 'x',
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
  it('prices a call by the minute: platform rate plus the LLM rate', () => {
    expect(elevenLabsCostUsd('claude-haiku-4-5', 600)).toBeCloseTo(10 * (0.08 + 0.0082), 6);
  });

  it('an LLM with no published rate is price unknown, never guessed', () => {
    expect(elevenLabsCostUsd('claude-sonnet-4-5', 600)).toBeNull();
  });

  it('is costed from the call length, named, and kept in the ledger', () => {
    const engine: EngineCosting = {
      backend: 'elevenlabs',
      model: 'claude-haiku-4-5',
      tokens: ZERO_TOKENS,
      stt: null,
      agentSeconds: 52,
    };
    const c = costCall({ ...base, engine, handoffs: 1 });
    expect(c.engineUsd).toBeCloseTo((52 / 60) * 0.0882, 6);
    expect(c.agentSeconds).toBe(52);
    expect(callSummaryLine(c)).toContain('ElevenLabs Haiku');
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const ledger = createVoiceLedger(join(dir, 'u.jsonl'));
    ledger.record(c);
    expect(createVoiceLedger(join(dir, 'u.jsonl')).totals(base.endedAt).allCalls).toBe(1);
  });
});
