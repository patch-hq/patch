import { describe, it, expect } from 'vitest';
import {
  PROVIDERS,
  DEFAULT_PROVIDER_ID,
  HarnessId,
  PermissionMode,
  providerDescriptor,
  providerForModel,
  providerForSessionId,
  providerBuiltinCommands,
  permissionModesFor,
  HARNESS_PERMISSION_MODES,
  BACKEND_IDS,
  backendIdForModel,
  accountsKeyForBackend,
  modelSupportsEffort,
  providerByName,
  providerForBackendId,
  CLAUDE_BACKEND_ID,
  ChatErrorCode,
} from '../src/index.js';

describe('provider built-in commands', () => {
  it('every provider declares its own, and routing follows the model', () => {
    for (const p of PROVIDERS) expect(p.builtinCommands.length).toBeGreaterThan(0);
    expect(providerBuiltinCommands('claude-opus-5').has('context')).toBe(true);
    expect(providerBuiltinCommands(null).has('context')).toBe(true);
    expect(providerBuiltinCommands('openai/gpt-5-codex').has('context')).toBe(false);
    expect(providerBuiltinCommands('openai/gpt-5-codex').has('approvals')).toBe(true);
  });

  it('never claims the commands Patch handles itself', () => {
    for (const p of PROVIDERS) {
      expect(p.builtinCommands).not.toContain('clear');
      expect(p.builtinCommands).not.toContain('goal');
    }
  });
});

describe('provider registry', () => {
  it('has unique ids and exactly one default (prefix-less) provider', () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(PROVIDERS.filter((p) => p.modelPrefix === null).map((p) => p.id)).toEqual([
      DEFAULT_PROVIDER_ID,
    ]);
    expect(PROVIDERS.filter((p) => p.sessionIdPrefix === null)).toHaveLength(1);
  });

  it('derives HarnessId from the registry', () => {
    expect(HarnessId.options).toEqual(PROVIDERS.map((p) => p.id));
  });

  it('routes models by prefix, default otherwise', () => {
    expect(providerForModel('openai/gpt-5-codex')).toBe('codex');
    expect(providerForModel('claude-opus-5')).toBe('claude');
    expect(providerForModel('some-future-model')).toBe('claude');
    expect(providerForModel(undefined)).toBe('claude');
  });

  it('identifies the provider of a native session id', () => {
    expect(providerForSessionId('codex-abc')).toBe('codex');
    expect(providerForSessionId('8c1f-uuid')).toBe('claude');
    expect(providerForSessionId(undefined)).toBeUndefined();
    expect(providerForSessionId('')).toBeUndefined();
  });

  it('throws on an unknown provider id', () => {
    expect(() => providerDescriptor('nope')).toThrow(/unknown provider/);
  });

  it('feeds the permission-mode table from the registry', () => {
    expect(HARNESS_PERMISSION_MODES.claude).toEqual(PermissionMode.options);
    expect(permissionModesFor('openai/gpt-5')).not.toContain('auto');
    expect(permissionModesFor('claude-opus-5')).toContain('auto');
  });
});

describe('provider account and capability facts', () => {
  it('every provider has a unique backend id and accounts key', () => {
    expect(new Set(PROVIDERS.map((p) => p.backendId)).size).toBe(PROVIDERS.length);
    expect(new Set(PROVIDERS.map((p) => p.accountsKey)).size).toBe(PROVIDERS.length);
    expect([...BACKEND_IDS]).toEqual(PROVIDERS.map((p) => p.backendId));
    for (const p of PROVIDERS) expect(() => ChatErrorCode.parse(p.loginRequiredCode)).not.toThrow();
  });

  it('keeps the claude backend id the wire constant', () => {
    expect(providerDescriptor('claude').backendId).toBe(CLAUDE_BACKEND_ID);
  });

  it('resolves backends, names and aliases', () => {
    expect(providerForBackendId('claude-code')).toBe('claude');
    expect(providerForBackendId('codex')).toBe('codex');
    expect(providerByName('openai')).toBe('codex');
    expect(providerByName('chatgpt')).toBe('codex');
    expect(providerByName('claude-code')).toBe('claude');
    expect(() => providerByName('nope')).toThrow('unknown provider');
    expect(() => providerForBackendId('nope')).toThrow('unknown backend');
  });

  it('routes a model to its backend, accounts key and effort support', () => {
    expect(backendIdForModel('openai/gpt-5')).toBe('codex');
    expect(backendIdForModel(undefined)).toBe('claude-code');
    expect(accountsKeyForBackend('codex')).toBe('codex');
    expect(accountsKeyForBackend('claude-code')).toBe('claude');
    expect(modelSupportsEffort('claude-opus-5')).toBe(true);
    expect(modelSupportsEffort('openai/gpt-5')).toBe(false);
  });
});
