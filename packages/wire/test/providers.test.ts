import { describe, it, expect } from 'vitest';
import {
  PROVIDERS,
  ACCOUNT_PROVIDERS,
  accountsForBackend,
  backendHasConnectedAccount,
  providerAccountKind,
  accountKindForModel,
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
  ACCOUNT_PROVIDERS,
  ModelEndpoints,
  RecordedHarnessId,
  endpointModelId,
  parseEndpointModel,
  retiredModelNotice,
} from '../src/index.js';

describe('provider built-in commands', () => {
  it('every provider declares its own, and routing follows the model', () => {
    for (const p of ACCOUNT_PROVIDERS) expect(p.builtinCommands.length).toBeGreaterThan(0);
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
    expect(new Set(ACCOUNT_PROVIDERS.map((p) => p.accountsKey)).size).toBe(
      ACCOUNT_PROVIDERS.length,
    );
    // Only providers with accounts take part in the accounts RPC and settings.
    expect([...BACKEND_IDS]).toEqual(ACCOUNT_PROVIDERS.map((p) => p.backendId));
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

describe('model endpoints', () => {
  it("route to the harness the endpoint API names, with that harness's capabilities", () => {
    const codexModel = endpointModelId({ id: 'ollama', api: 'openai' }, 'qwen3:8b');
    const claudeModel = endpointModelId({ id: 'router', api: 'anthropic' }, 'anthropic/claude-x');
    expect(codexModel).toBe('openai/endpoint/ollama/qwen3:8b');
    expect(providerForModel(codexModel)).toBe('codex');
    expect(providerForModel(claudeModel)).toBe('claude');
    expect(permissionModesFor(codexModel)).not.toContain('auto');
    expect(parseEndpointModel(codexModel)).toEqual({
      api: 'openai',
      endpointId: 'ollama',
      model: 'qwen3:8b',
    });
    expect(parseEndpointModel(claudeModel)?.model).toBe('anthropic/claude-x');
    expect(parseEndpointModel('openai/gpt-5')).toBeUndefined();
    expect(parseEndpointModel('openai/endpoint/ollama/')).toBeUndefined();
    expect(parseEndpointModel('openai/endpoint/Bad_Id/x')).toBeUndefined();
  });

  it('there is no local provider; its old records still parse and its chats name a successor', () => {
    expect(PROVIDERS.map((p) => p.id)).not.toContain('local');
    expect(() => providerByName('ollama')).toThrow('unknown provider');
    expect(HarnessId.safeParse('local').success).toBe(false);
    expect(RecordedHarnessId.parse('local')).toBe('local');
    expect(retiredModelNotice('openai/gpt-5')).toBeUndefined();
    expect(retiredModelNotice('local/qwen3:8b')).toMatchObject({
      replacementModel: 'openai/endpoint/local/qwen3:8b',
      message: expect.stringContaining('cannot continue'),
    });
  });

  it('refuses two endpoints with one id', () => {
    const e = { id: 'a', label: 'A', api: 'openai', baseUrl: 'http://h:1/v1' };
    expect(ModelEndpoints.safeParse([e, e]).success).toBe(false);
    expect(ModelEndpoints.safeParse([e]).success).toBe(true);
  });
});

import { modelHasCapability, providerCapabilities, PROVIDERS as REG } from '../src/providers.js';

describe('provider capabilities', () => {
  it('every provider declares every capability as a boolean', () => {
    const keys = [
      'resume',
      'editAtMessage',
      'rewind',
      'branchAtTurn',
      'disableNativeTools',
      'interrupt',
      'steer',
      'systemPrompt',
    ];
    for (const p of REG) {
      expect(Object.keys(p.capabilities).sort()).toEqual([...keys].sort());
      for (const k of keys)
        expect(typeof (p.capabilities as Record<string, boolean>)[k]).toBe('boolean');
    }
  });

  it('reads capabilities by model', () => {
    expect(modelHasCapability('claude-opus-5', 'editAtMessage')).toBe(true);
    expect(modelHasCapability('openai/gpt-5', 'steer')).toBe(true);
    expect(modelHasCapability('openai/gpt-5', 'rewind')).toBe(false);
    expect(providerCapabilities('openai/endpoint/ollama/x').branchAtTurn).toBe(true);
  });
});

// Account wiring reads the table, never a provider's name (decision 16).
describe('account wiring from the table', () => {
  const secrets = {
    claude: [{ id: 'a', connected: false }],
    codex: [{ id: 'b', connected: true }],
  };

  it('picks a provider’s accounts by its backend id, empty while absent', () => {
    for (const p of ACCOUNT_PROVIDERS) {
      expect(accountsForBackend(secrets, p.backendId)).toBe(
        secrets[p.accountsKey as keyof typeof secrets],
      );
      expect(accountsForBackend({}, p.backendId)).toEqual([]);
      expect(accountsForBackend(null, p.backendId)).toEqual([]);
    }
  });

  it('says whether any of a provider’s accounts is connected', () => {
    const connected = ACCOUNT_PROVIDERS.filter((p) =>
      backendHasConnectedAccount(secrets, p.backendId),
    ).map((p) => p.accountsKey);
    expect(connected).toEqual(['codex']);
  });

  it('a provider’s adapter reads its account kind for a model from accountKinds', () => {
    for (const p of PROVIDERS) {
      if (p.accountKinds === null) {
        expect(() => providerAccountKind(p.id, undefined)).toThrow(/no kinds/);
        continue;
      }
      expect(providerAccountKind(p.id, undefined)).toBe(p.accountKinds.default);
      for (const { prefix, kind } of p.accountKinds.byModelPrefix) {
        expect(providerAccountKind(p.id, `${prefix}model`)).toBe(kind);
        expect(accountKindForModel(`${prefix}model`)).toBe(kind);
      }
    }
  });

  it('exactly the providers whose own configuration hosts report say so', () => {
    for (const p of PROVIDERS) expect(typeof p.ownSettingsReportedByHost).toBe('boolean');
  });
});
