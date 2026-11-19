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

  it('a Claude chat on a model endpoint has no account to retry on or sweep, nor a status line', () => {
    const t = harnessTraitsForModel('claude/endpoint/router/x');
    expect(t.backendId).toBe(HARNESS_TRAITS.claude.backendId);
    expect(t.generatesStatus).toBe(false);
    expect(t.rateLimitSweeps).toBe(false);
    expect(t.hostCreditAggregate).toBe(false);
    expect(t.turnRetrySafe(new Error('x'))).toBe(false);
    expect(harnessTraitsForModel('claude-opus-5')).toBe(HARNESS_TRAITS.claude);
    expect(harnessTraitsForModel('openai/endpoint/ollama/q')).toBe(HARNESS_TRAITS.codex);
  });
});

describe('host wiring reads provider adapters', () => {
  it('index.ts and titleGen.ts ask no isCodexModel/isLocalModel question', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of ['../src/index.ts', '../src/titleGen.ts']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src.match(/\bis(Codex|Local)Model\(/g) ?? []).toEqual([]);
      expect(src.match(/spawnProvider\.id === '/g) ?? []).toEqual([]);
    }
  });

  it('adapterForModel picks the adapter by the model’s provider', async () => {
    const { adapterForModel } = await import('../src/providerAdapters.js');
    const mk = (name: string) => ({ name }) as never;
    const adapters = { claude: mk('c'), codex: mk('x'), gemini: mk('g') };
    expect((adapterForModel(adapters, 'openai/gpt-5') as unknown as { name: string }).name).toBe(
      'x',
    );
    expect((adapterForModel(adapters, 'gemini/g') as unknown as { name: string }).name).toBe('g');
    // A model endpoint is a model inside a harness, never an adapter of its own.
    expect(
      (adapterForModel(adapters, 'openai/endpoint/ollama/q') as unknown as { name: string }).name,
    ).toBe('x');
    expect(
      (adapterForModel(adapters, 'claude/endpoint/router/q') as unknown as { name: string }).name,
    ).toBe('c');
    expect((adapterForModel(adapters, undefined) as unknown as { name: string }).name).toBe('c');
  });
});
