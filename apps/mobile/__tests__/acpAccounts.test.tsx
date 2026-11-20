// Settings → Usage → ACP agents on mobile (spec/10 § Backend credentials,
// § Signing in). An ACP agent signs in with an API key the server checks and
// stores; each account shows its last four and state, never the key, and every
// change settles on the server's answer.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, type ReactTestRenderer } from 'react-test-renderer';
import { DEFAULT_SHARED_SETTINGS } from '@patch/wire';
import {
  renderRN,
  byTestId,
  findHost,
  queryHost,
  textOf,
  actAsync,
  flush,
} from './testUtils/render';
import { AcpAccountsSections } from '../src/components/settings/AcpAccountsSection';
import { api, ApiError } from '../src/api/rest';
import { __getLastAlert, __clearLastAlert } from './stubs/react-native';
import { resetHosts, seedSettings } from './testUtils/settingsFixtures';

vi.mock('../src/api/rest', () => {
  class ApiError extends Error {
    override readonly name = 'ApiError';
    constructor(
      readonly status: number,
      message: string,
      readonly body: unknown,
    ) {
      super(message);
    }
  }
  return {
    ApiError,
    api: { addAcpAccount: vi.fn(), replaceAcpKey: vi.fn(), removeAcpAccount: vi.fn() },
  };
});

const KEY = 'AIzaFakeGeminiKeyForTests00001111';
const WORK = {
  id: 'a1',
  agentId: 'gemini',
  label: 'Work',
  last4: '1111',
  state: { state: 'ready' as const },
};

function state(acp: (typeof WORK)[] | undefined) {
  return {
    version: 2,
    settings: { ...DEFAULT_SHARED_SETTINGS },
    secrets: { claude: [], codex: [], providerKeys: [], ...(acp ? { acp } : {}) },
    hosts: [],
  };
}

function seed(acp?: (typeof WORK)[]): void {
  seedSettings({ shared: { version: 1, secrets: state(acp).secrets, hosts: [] } });
}

const mounted: ReactTestRenderer[] = [];
function open(): ReactTestRenderer {
  const r = renderRN(<AcpAccountsSections />);
  mounted.push(r);
  return r;
}
afterEach(() => {
  act(() => {
    for (const r of mounted.splice(0)) r.unmount();
  });
});
beforeEach(() => {
  vi.clearAllMocks();
  __clearLastAlert();
  resetHosts();
});

describe('mobile Settings → Usage → ACP agents', () => {
  it('shows Gemini CLI with no accounts', () => {
    seed();
    const r = open();
    expect(queryHost(r.root, byTestId('acp-accounts-gemini-empty'))).not.toBeNull();
  });

  it('lists an account with its last four and state, never the key', () => {
    seed([WORK]);
    const r = open();
    expect(textOf(findHost(r.root, byTestId('acp-account-a1-status')))).toBe(
      'API key · ends 1111 · Ready',
    );
  });

  it('adds an account from a secure field and settles on the answer', async () => {
    seed();
    vi.mocked(api.addAcpAccount).mockResolvedValue(state([WORK]) as never);
    const r = open();
    await actAsync(() => findHost(r.root, byTestId('acp-accounts-gemini-add')).props.onPress());
    const input = findHost(r.root, byTestId('acp-accounts-gemini-input'));
    expect(input.props.secureTextEntry).toBe(true);
    await actAsync(() => input.props.onChangeText(` ${KEY} `));
    await actAsync(async () => {
      findHost(r.root, byTestId('acp-accounts-gemini-save')).props.onPress();
      await flush();
    });
    expect(api.addAcpAccount).toHaveBeenCalledWith('gemini', KEY);
    expect(queryHost(r.root, byTestId('acp-accounts-gemini-input'))).toBeNull();
    expect(queryHost(r.root, byTestId('acp-account-a1'))).not.toBeNull();
  });

  it('a refused key says the server words and keeps the form open', async () => {
    seed();
    vi.mocked(api.addAcpAccount).mockRejectedValue(
      new ApiError(400, 'credential_rejected', {
        message: 'The provider refused this key (HTTP 400)',
      }),
    );
    const r = open();
    await actAsync(() => findHost(r.root, byTestId('acp-accounts-gemini-add')).props.onPress());
    await actAsync(() =>
      findHost(r.root, byTestId('acp-accounts-gemini-input')).props.onChangeText(KEY),
    );
    await actAsync(async () => {
      findHost(r.root, byTestId('acp-accounts-gemini-save')).props.onPress();
      await flush();
    });
    expect(__getLastAlert()?.message).toBe('The provider refused this key (HTTP 400)');
    expect(queryHost(r.root, byTestId('acp-accounts-gemini-input'))).not.toBeNull();
  });

  it('replaces a key, and removes an account after asking', async () => {
    seed([WORK]);
    vi.mocked(api.replaceAcpKey).mockResolvedValue(state([{ ...WORK, last4: '2222' }]) as never);
    vi.mocked(api.removeAcpAccount).mockResolvedValue(state(undefined) as never);
    const r = open();
    await actAsync(() => findHost(r.root, byTestId('acp-account-a1-replace')).props.onPress());
    await actAsync(() =>
      findHost(r.root, byTestId('acp-accounts-gemini-input')).props.onChangeText(KEY),
    );
    await actAsync(async () => {
      findHost(r.root, byTestId('acp-accounts-gemini-save')).props.onPress();
      await flush();
    });
    expect(api.replaceAcpKey).toHaveBeenCalledWith('gemini', 'a1', KEY);
    expect(textOf(findHost(r.root, byTestId('acp-account-a1-status')))).toContain('ends 2222');

    await actAsync(() => findHost(r.root, byTestId('acp-account-a1-remove')).props.onPress());
    expect(api.removeAcpAccount).not.toHaveBeenCalled();
    const remove = __getLastAlert()?.buttons?.find((b) => b.text === 'Remove');
    await actAsync(async () => {
      remove?.onPress?.();
      await flush();
    });
    expect(api.removeAcpAccount).toHaveBeenCalledWith('gemini', 'a1');
    expect(queryHost(r.root, byTestId('acp-accounts-gemini-empty'))).not.toBeNull();
  });
});
