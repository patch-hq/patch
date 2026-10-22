// spec/04 § Handoff budget — the host-side pieces around the planner: where a
// window comes from, the divider's words, and the typed overflow.

import { describe, it, expect } from 'vitest';
import {
  ModelLimits,
  budgetFor,
  dividerCopy,
  estimateIsOff,
  instructionHash,
  UNASSUMED_WINDOW_TOKENS,
  DEFAULT_OUTPUT_TOKENS,
} from '../src/handoffRun.js';
import { reportedContextLimit } from '../src/sdkBackend.js';
import { ModelCatalog } from '../src/modelCatalog.js';

describe('model limits', () => {
  it('uses a window a model has reported and flags it as known', () => {
    const limits = new ModelLimits();
    limits.note('m', { contextWindow: 272_000, maxOutputTokens: 16_000 });
    const { budget, windowKnown } = budgetFor(limits.get('m'), {});
    expect(windowKnown).toBe(true);
    expect(budget.contextWindow).toBe(272_000);
    expect(budget.outputTokens).toBe(16_000);
  });

  it('assumes a small window for an unreported model and says so', () => {
    const { budget, windowKnown } = budgetFor(new ModelLimits().get('nope'), {});
    expect(windowKnown).toBe(false);
    expect(budget.contextWindow).toBe(UNASSUMED_WINDOW_TOKENS);
    expect(budget.outputTokens).toBe(DEFAULT_OUTPUT_TOKENS);
  });

  it('counts the host prompts as instructions', () => {
    const small = budgetFor(undefined, {}).budget.instructionsTokens;
    const big = budgetFor(undefined, { systemPrompt: 'x'.repeat(40_000) }).budget
      .instructionsTokens;
    expect(big - small).toBe(10_000);
  });

  it('a later report replaces an earlier one and never zeroes it', () => {
    const limits = new ModelLimits();
    limits.note('m', { contextWindow: 100 });
    limits.note('m', { contextWindow: 0 });
    limits.note('m', { maxOutputTokens: 5 });
    expect(limits.get('m')).toEqual({ contextWindow: 100, maxOutputTokens: 5 });
  });
});

describe('divider copy', () => {
  const base = {
    model: 'openai/gpt-6-astra',
    carried: 120,
    total: 4100,
    estimatedTokens: 38000,
    availableTokens: 190000,
    windowKnown: true,
    summary: false,
    replanned: false,
  };
  it('names carried vs total, on-demand history and the missing summary', () => {
    const text = dividerCopy({ ...base, summaryNote: 'the previous model was unavailable' });
    expect(text).toContain('carried 120 of 4,100 entries');
    expect(text).toContain('older history readable on demand');
    expect(text).toContain('~38,000 of 190,000 tokens');
    expect(text).toContain('no model-written summary (the previous model was unavailable)');
  });
  it('says when the window was assumed and when it was re-planned', () => {
    const text = dividerCopy({ ...base, windowKnown: false, replanned: true });
    expect(text).toContain('(window assumed)');
    expect(text).toContain('re-planned smaller');
  });
  it('a whole-track handoff claims no omitted history', () => {
    const text = dividerCopy({ ...base, carried: 4100 });
    expect(text).toContain('carried all 4,100 entries');
    expect(text).not.toContain('on demand');
  });
});

describe('verification helpers', () => {
  it('hashes the instruction byte-exactly', () => {
    expect(instructionHash('a')).toBe(
      'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
    );
    expect(instructionHash('a ')).not.toBe(instructionHash('a'));
  });
  it('flags an estimate more than 2x off in either direction', () => {
    expect(estimateIsOff(1000, 1900)).toBe(false);
    expect(estimateIsOff(1000, 2100)).toBe(true);
    expect(estimateIsOff(1000, 400)).toBe(true);
    expect(estimateIsOff(1000, null)).toBe(false);
  });
  it('reads the window a provider names in an overflow', () => {
    expect(
      reportedContextLimit('maximum context length is 272,000 tokens, however you requested 900'),
    ).toBe(272000);
    expect(reportedContextLimit('context_length_exceeded')).toBeUndefined();
  });
});

describe('the catalogue feeds model limits', () => {
  it('notes the window and output cap Anthropic states, per model', async () => {
    const limits = new ModelLimits();
    const catalog = new ModelCatalog({
      runOnAccountWithCredit: async (_label, fn) => fn('token'),
      limits,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'claude-a',
                display_name: 'A',
                max_input_tokens: 1_000_000,
                max_tokens: 64_000,
              },
              { id: 'claude-b', display_name: 'B' },
            ],
          }),
        )) as typeof fetch,
    });
    await catalog.get();
    expect(limits.get('claude-a')).toEqual({ contextWindow: 1_000_000, maxOutputTokens: 64_000 });
    expect(limits.get('claude-b')).toBeUndefined();
  });
});
