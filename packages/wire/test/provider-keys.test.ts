import { describe, expect, it } from 'vitest';
import {
  HostInfoEvent,
  HostProviderKey,
  HostProviderKeys,
  PROVIDER_KEYS,
  ProviderKeyId,
  providerKeyEnvOnlyNote,
  providerKeyInfo,
  providerKeyStatusText,
} from '../src/index.js';

describe('provider key catalogue', () => {
  it('lists every id once, with the env var the host reads', () => {
    expect(PROVIDER_KEYS.map((k) => k.id)).toEqual(ProviderKeyId.options);
    expect(providerKeyInfo('gemini').envVar).toBe('GEMINI_API_KEY');
    // Deliberately not OPENAI_API_KEY: agent processes would pick that one up.
    expect(providerKeyInfo('openai').envVar).toBe('OPENAI_REALTIME_API_KEY');
    expect(providerKeyInfo('deepgram').envVar).toBe('DEEPGRAM_API_KEY');
    expect(ProviderKeyId.safeParse('groq').success).toBe(false);
  });
});

describe('HostProviderKeys', () => {
  it('drops the retired Groq key an older host still reports, so the rest of its state parses', () => {
    expect(
      HostProviderKeys.parse([
        { id: 'groq', source: 'env', last4: 'abcd', envSet: true },
        { id: 'gemini', source: 'ui', last4: 'wxyz', envSet: false },
      ]).map((k) => k.id),
    ).toEqual(['gemini']);
  });
});

describe('HostProviderKey', () => {
  it('has no field that could carry a value', () => {
    const withValue = HostProviderKey.safeParse({
      id: 'gemini',
      source: 'ui',
      last4: 'abcd',
      envSet: false,
      value: 'AIzaSy-full-value',
    });
    expect(withValue.success).toBe(false);
  });

  it('refuses a last4 longer than four characters', () => {
    expect(
      HostProviderKey.safeParse({ id: 'deepgram', source: 'env', last4: 'abcde', envSet: true })
        .success,
    ).toBe(false);
  });

  it('rides on daemon.host', () => {
    const host = {
      type: 'host.host',
      hostId: 'h1',
      hostName: 'h1',
      platform: 'linux',
      arch: 'x64',
      hostVersion: '1.0.0',
      updateAvailable: false,
      permissionModeDefault: 'default',
      permissionOverrides: 0,
      runsManager: true,
      audioRelayHost: '127.0.0.1:3003',
      backends: [],
      components: [],
      providerKeys: [{ id: 'gemini', source: 'none', envSet: false }],
    };
    expect(HostInfoEvent.parse(host).providerKeys).toEqual([
      { id: 'gemini', source: 'none', envSet: false },
    ]);
  });
});

describe('status text', () => {
  it('names the source, the last four, and precedence', () => {
    expect(
      providerKeyStatusText({ id: 'gemini', source: 'ui', last4: 'wxyz', envSet: false }),
    ).toBe('Set from UI · ends wxyz');
    expect(providerKeyStatusText({ id: 'gemini', source: 'ui', last4: 'wxyz', envSet: true })).toBe(
      'Set from UI · ends wxyz (overrides environment)',
    );
    expect(
      providerKeyStatusText({ id: 'deepgram', source: 'env', last4: '1234', envSet: true }),
    ).toBe('Set from environment · ends 1234');
    expect(providerKeyStatusText({ id: 'openai', source: 'none', envSet: false })).toBe('Not set');
  });

  it('says why an env-only key has no Revoke', () => {
    expect(
      providerKeyEnvOnlyNote({ id: 'deepgram', source: 'env', last4: '1234', envSet: true }),
    ).not.toContain('DEEPGRAM_API_KEY');
    expect(providerKeyEnvOnlyNote({ id: 'deepgram', source: 'ui', last4: '1', envSet: true })).toBe(
      null,
    );
  });
});
