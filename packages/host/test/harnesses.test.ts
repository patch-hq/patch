import { describe, it, expect } from 'vitest';
import { PROVIDERS } from '@patch/wire';
import {
  HARNESS_TRAITS,
  harnessModesInclude,
  harnessOfSessionId,
  harnessTraitsForModel,
} from '../src/harnesses.js';
import { CodexTurnError } from '../src/codexBackend.js';

describe('harness traits', () => {
  it('has traits for every registered provider', () => {
    expect(Object.keys(HARNESS_TRAITS).sort()).toEqual(PROVIDERS.map((p) => p.id).sort());
  });

  it('reads traits by model', () => {
    expect(harnessTraitsForModel('openai/gpt-5').backendId).toBe('codex');
    expect(harnessTraitsForModel('claude-opus-5').rateLimitSweeps).toBe(true);
    expect(harnessTraitsForModel(undefined).generatesStatus).toBe(true);
  });

  it('codex retries only when the turn says it is safe', () => {
    const t = HARNESS_TRAITS.codex.turnRetrySafe;
    expect(t(new Error('x'))).toBe(false);
    expect(t(new CodexTurnError('x', true))).toBe(true);
  });

  it('codex cannot run auto; claude can', () => {
    expect(harnessModesInclude('openai/gpt-5', 'auto')).toBe(false);
    expect(harnessModesInclude('claude-opus-5', 'auto')).toBe(true);
    expect(harnessModesInclude(undefined, 'auto')).toBe(true);
  });

  it('maps session ids to harnesses', () => {
    expect(harnessOfSessionId('codex-1')).toBe('codex');
    expect(harnessOfSessionId(undefined)).toBeUndefined();
  });
});

describe('the chat core does not branch on a provider name', () => {
  it('chatRunner.ts compares no harness id to a provider literal; it reads traits', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/chatRunner.ts', import.meta.url), 'utf8');
    expect(src.match(/[!=]==\s*'(claude|codex|local)'/g) ?? []).toEqual([]);
  });

  it('each provider names the run option it reseeds through, or none', () => {
    expect(HARNESS_TRAITS.codex.reseedOption).toBe('codexReseed');
    expect(HARNESS_TRAITS.local.reseedOption).toBe('localReseed');
    expect(HARNESS_TRAITS.claude.reseedOption).toBeNull();
    expect(HARNESS_TRAITS.codex.sessionMovable).toBe(false);
    expect(HARNESS_TRAITS.claude.ownsSessionFile).toBe(true);
  });
});
