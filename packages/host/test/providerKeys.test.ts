// The host's provider-key store (spec/02 § Provider keys): a cache of the
// shared keys the server sends (0600), the shared key wins over the
// environment, changes apply live, and no value ever leaves except through
// `get()`. Nothing on the host sets or deletes a key of its own.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderKeyError, ProviderKeyStore, providerKeysPath } from '../src/providerKeys.js';

// Obviously fake values, long enough to pass the length floor.
const UI_GEMINI = 'ui-gemini-fake-value-000000-WXYZ';
const ENV_GEMINI = 'env-gemini-fake-value-00000-ENV1';
const UI_GROQ = 'ui-groq-fake-value-0000000-GRQ9';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'patch-provider-keys-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function store(
  env: ConstructorParameters<typeof ProviderKeyStore>[0]['env'] = {},
  extra: Partial<ConstructorParameters<typeof ProviderKeyStore>[0]> = {},
): ProviderKeyStore {
  return new ProviderKeyStore({ path: providerKeysPath(home), env, ...extra });
}

describe('ProviderKeyStore — storage', () => {
  it('caches the shared keys in keys.json under PATCH_HOME with mode 0600', () => {
    store().replaceAll({ gemini: UI_GEMINI });
    const path = join(home, 'keys.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      version: 1,
      keys: { gemini: UI_GEMINI },
    });
  });

  it('survives a restart with the server away: a new store reads what the last one cached', () => {
    store().replaceAll({ groq: UI_GROQ });
    expect(store().get('groq')).toBe(UI_GROQ);
  });

  it('narrows a file someone widened back to 0600 on load', () => {
    store().replaceAll({ gemini: UI_GEMINI });
    const path = join(home, 'keys.json');
    chmodSync(path, 0o644);
    store();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('refuses to boot on a malformed file rather than starting empty (NO FALLBACK)', () => {
    writeFileSync(join(home, 'keys.json'), '{"keys": {"gemini": 1}}', { mode: 0o600 });
    expect(() => store()).toThrow(/not a valid provider-key file/);
  });

  it('refuses an unknown key id in the file', () => {
    writeFileSync(
      join(home, 'keys.json'),
      JSON.stringify({ version: 1, keys: { anthropic: 'x' } }),
      { mode: 0o600 },
    );
    expect(() => store()).toThrow(/not a valid provider-key file/);
  });
});

describe('ProviderKeyStore — precedence', () => {
  it('a shared key wins over the environment, and one dropped from the snapshot restores it', () => {
    const s = store({ gemini: ENV_GEMINI });
    expect(s.get('gemini')).toBe(ENV_GEMINI);
    s.replaceAll({ gemini: UI_GEMINI });
    expect(s.get('gemini')).toBe(UI_GEMINI);
    s.replaceAll({});
    expect(s.get('gemini')).toBe(ENV_GEMINI);
  });

  it('describe() states the source and last four, and nothing else', () => {
    const s = store({ gemini: ENV_GEMINI, groq: 'env-groq-fake-value-000000-G1G2' });
    s.replaceAll({ gemini: UI_GEMINI });
    const described = s.describe();
    expect(described).toEqual([
      { id: 'gemini', source: 'ui', last4: 'WXYZ', envSet: true },
      { id: 'openai', source: 'none', envSet: false },
      { id: 'elevenlabs', source: 'none', envSet: false },
      { id: 'groq', source: 'env', last4: 'G1G2', envSet: true },
      { id: 'deepgram', source: 'none', envSet: false },
      { id: 'assemblyai', source: 'none', envSet: false },
    ]);
    const json = JSON.stringify(described);
    expect(json).not.toContain(UI_GEMINI);
    expect(json).not.toContain(ENV_GEMINI);
  });
});

describe('ProviderKeyStore — live change', () => {
  it('tells listeners after each change, once the file holds it', () => {
    const s = store();
    const seen: Array<string | undefined> = [];
    s.onChange(() => {
      seen.push(JSON.parse(readFileSync(join(home, 'keys.json'), 'utf8')).keys.gemini);
    });
    s.replaceAll({ gemini: UI_GEMINI });
    s.replaceAll({});
    expect(seen).toEqual([UI_GEMINI, undefined]);
  });

  it('a refused change tells nobody', () => {
    const s = store({}, { requiredToStart: { groq: 'This host transcribes with Groq' } });
    let calls = 0;
    s.onChange(() => calls++);
    expect(() => s.replaceAll({})).toThrow();
    expect(calls).toBe(0);
  });
});

describe('ProviderKeyStore — from the shared settings (spec/01 § Settings)', () => {
  it('replaces every Settings-set key with the snapshot’s, and tells listeners once', () => {
    const s = store();
    s.replaceAll({ gemini: UI_GEMINI });
    let told = 0;
    s.onChange(() => (told += 1));
    s.replaceAll({ groq: UI_GROQ });
    expect(s.get('gemini')).toBeUndefined();
    expect(s.get('groq')).toBe(UI_GROQ);
    expect(store().get('groq')).toBe(UI_GROQ);
    expect(told).toBe(1);
    // The same set again writes nothing and tells nobody.
    s.replaceAll({ groq: UI_GROQ });
    expect(told).toBe(1);
  });

  it('refuses a snapshot without the key this host needs to start, changing nothing', () => {
    const s = store({}, { requiredToStart: { groq: 'This host transcribes with Groq' } });
    s.setRequiredToStart({});
    s.replaceAll({ groq: UI_GROQ });
    s.setRequiredToStart({ groq: 'This host transcribes with Groq' });
    expect(() => s.replaceAll({})).toThrow(ProviderKeyError);
    expect(s.get('groq')).toBe(UI_GROQ);
  });

  it('allows it when the environment still has one', () => {
    const s = store(
      { groq: 'env-groq-fake-value-000000-ENV2' },
      { requiredToStart: { groq: 'groq host' } },
    );
    s.replaceAll({});
    expect(s.get('groq')).toBe('env-groq-fake-value-000000-ENV2');
  });

  it('hands up every key it holds for the import, Settings-set ahead of the environment’s', () => {
    const s = store({ gemini: ENV_GEMINI });
    s.replaceAll({ groq: UI_GROQ });
    expect(s.settingsKeys()).toEqual({ gemini: ENV_GEMINI, groq: UI_GROQ });
    expect(s.envValue('gemini')).toBe(ENV_GEMINI);
    expect(s.envValue('openai')).toBeUndefined();
  });
});

describe('ProviderKeyStore — blank environment values', () => {
  it('treats an empty or whitespace env var as not set', () => {
    const s = store({ gemini: '', openai: '   ', groq: undefined });
    expect(s.get('gemini')).toBeUndefined();
    expect(s.has('gemini')).toBe(false);
    expect(s.has('openai')).toBe(false);
    expect(s.envValue('gemini')).toBeUndefined();
    const gemini = s.describe().find((k) => k.id === 'gemini');
    expect(gemini).toEqual({ id: 'gemini', source: 'none', envSet: false });
  });

  it('lets a shared key apply when the env var is blank', () => {
    const s = store({ gemini: '' });
    s.replaceAll({ gemini: UI_GEMINI });
    expect(s.get('gemini')).toBe(UI_GEMINI);
    s.replaceAll({});
    expect(s.get('gemini')).toBeUndefined();
  });
});
