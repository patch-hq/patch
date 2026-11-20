// Settings → Usage → an ACP agent's own sign-in on a host, on the phone (spec/10
// § Signing in → an ACP agent): signed in on that host only, the address to
// open, a code, and the address the browser ended on sent back.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, type ReactTestRenderer } from 'react-test-renderer';
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
import { api } from '../src/api/rest';
import { usePresenceStore } from '../src/stores/presenceStore';
import { reportHost, resetHosts, seedSettings } from './testUtils/settingsFixtures';

vi.mock('../src/api/rest', () => ({
  api: {
    startAcpLogin: vi.fn(),
    acpLogin: vi.fn(),
    acpLoginCallback: vi.fn(),
    cancelAcpLogin: vi.fn(),
  },
}));

const view = (over: Record<string, unknown>) => ({
  loginId: 'l1',
  hostId: 'h1',
  agentId: 'gemini',
  methodId: 'oauth-personal',
  status: 'starting',
  ...over,
});

const mounted: ReactTestRenderer[] = [];
afterEach(() => {
  act(() => {
    for (const r of mounted.splice(0)) r.unmount();
  });
});
beforeEach(() => {
  vi.clearAllMocks();
  resetHosts();
  seedSettings({
    shared: { version: 1, hosts: [], secrets: { claude: [], codex: [], providerKeys: [] } },
  });
  reportHost('h1', {
    hostName: 'Mac',
    backends: [
      {
        id: 'acp:gemini',
        label: 'Gemini CLI',
        version: '0.70.0',
        state: 'logged-out',
        loginMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }],
      },
    ],
  });
});

function open(): ReactTestRenderer {
  const r = renderRN(<AcpAccountsSections />);
  mounted.push(r);
  return r;
}

describe('mobile: signing an ACP agent in on a host', () => {
  it('says signed in on that host only when its report says so', () => {
    usePresenceStore.getState().setHostAccount({
      type: 'host.account',
      hostId: 'h1',
      backendId: 'acp',
      connected: true,
      accounts: [{ id: 'acp-login:h1:gemini', label: 'Gemini CLI', connected: true }],
    });
    const r = open();
    expect(textOf(findHost(r.root, byTestId('acp-login-gemini-h1-status')))).toBe(
      'Signed in on Mac only — the login stays on that host',
    );
  });

  it('starts it, offers the sign-in page, and sends back the pasted address', async () => {
    vi.mocked(api.startAcpLogin).mockResolvedValue(
      view({ status: 'waiting', url: 'https://accounts.google.com/a', loopback: true }) as never,
    );
    vi.mocked(api.acpLogin).mockResolvedValue(
      view({ status: 'waiting', url: 'https://accounts.google.com/a', loopback: true }) as never,
    );
    vi.mocked(api.acpLoginCallback).mockResolvedValue(
      view({ status: 'waiting', url: 'https://accounts.google.com/a', loopback: true }) as never,
    );
    const r = open();
    expect(textOf(findHost(r.root, byTestId('acp-login-gemini-h1-status')))).toBe(
      'Not signed in on Mac',
    );
    await actAsync(async () => {
      findHost(r.root, byTestId('acp-login-gemini-h1-start')).props.onPress();
      await flush();
    });
    expect(api.startAcpLogin).toHaveBeenCalledWith('gemini', 'h1', 'oauth-personal');
    expect(queryHost(r.root, byTestId('acp-login-gemini-h1-url'))).not.toBeNull();
    await actAsync(() =>
      findHost(r.root, byTestId('acp-login-gemini-h1-paste')).props.onChangeText(
        'http://127.0.0.1:41234/oauth2callback?code=c',
      ),
    );
    await actAsync(async () => {
      findHost(r.root, byTestId('acp-login-gemini-h1-send')).props.onPress();
      await flush();
    });
    expect(api.acpLoginCallback).toHaveBeenCalledWith(
      'gemini',
      'l1',
      'http://127.0.0.1:41234/oauth2callback?code=c',
    );
  });

  it('shows a device code, and a failure in its own words', async () => {
    vi.mocked(api.startAcpLogin).mockResolvedValue(
      view({
        status: 'waiting',
        url: 'https://example.com/device',
        userCode: 'WXYZ-1234',
      }) as never,
    );
    const r = open();
    await actAsync(async () => {
      findHost(r.root, byTestId('acp-login-gemini-h1-start')).props.onPress();
      await flush();
    });
    expect(textOf(findHost(r.root, byTestId('acp-login-gemini-h1-code')))).toBe('Code: WXYZ-1234');
    expect(queryHost(r.root, byTestId('acp-login-gemini-h1-paste'))).toBeNull();

    vi.mocked(api.startAcpLogin).mockResolvedValue(
      view({ status: 'failed', message: 'Gemini CLI: the sign-in was refused' }) as never,
    );
    const r2 = open();
    await actAsync(async () => {
      findHost(r2.root, byTestId('acp-login-gemini-h1-start')).props.onPress();
      await flush();
    });
    expect(queryHost(r2.root, byTestId('acp-login-gemini-h1-failed'))).not.toBeNull();
  });
});
