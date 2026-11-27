// Settings → AI accounts → an ACP agent's own sign-in on a host (spec/10 §
// Signing in → an ACP agent). Each host with the agent says whether it is
// signed in there — on that host only — and signs it in: the address to open, a
// code, and the address the browser ended on sent back when the agent waits for
// a redirect on the host.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AcpAccounts } from '../routes/settings/AcpAccounts.js';
import { ErrorToasts } from '../components/ErrorToasts.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api, ApiError, type AcpLoginView } from '../api/rest.js';
import { clearHosts, reportHost } from './presenceHelpers.js';
import { loadShared, resetShared } from './sharedHelpers.js';

const LOGIN = [{ id: 'oauth-personal', name: 'Log in with Google' }];
const agentRow = (loginMethods = LOGIN) => ({
  id: 'acp:gemini',
  label: 'Gemini CLI',
  version: '0.70.0',
  state: 'logged-out' as const,
  loginMethods,
});
const view = (over: Partial<AcpLoginView>): AcpLoginView => ({
  loginId: 'l1',
  hostId: 'h1',
  agentId: 'gemini',
  methodId: 'oauth-personal',
  status: 'starting',
  ...over,
});

function seed(signedIn?: boolean): void {
  reportHost('h1', { hostName: 'Mac', backends: [agentRow()] });
  usePresenceStore.getState().setHostOnline('h1', true);
  if (signedIn !== undefined) {
    usePresenceStore.getState().setHostAccount({
      type: 'host.account',
      hostId: 'h1',
      backendId: 'acp',
      connected: signedIn,
      accounts: [
        {
          id: 'acp-login:h1:gemini',
          label: 'Gemini CLI · signed in on Mac only',
          connected: signedIn,
          ...(signedIn ? {} : { needsSignIn: true }),
        },
      ],
    });
  }
}

describe('signing an ACP agent in on a host', () => {
  beforeEach(() => {
    clearHosts();
    resetShared();
    loadShared();
    useUiStore.getState().clearToasts();
    usePresenceStore.getState().setConnection('connected');
  });
  afterEach(() => vi.restoreAllMocks());

  it('says whether the agent is signed in on each host, and that it is that host’s only', () => {
    seed(true);
    render(<AcpAccounts />);
    expect(screen.getByTestId('acp-login-gemini-h1-status')).toHaveTextContent(
      'Signed in on Mac only — the login stays on that host',
    );
    expect(screen.getByTestId('acp-login-gemini-h1-start')).toHaveTextContent('Sign in again');
  });

  it('shows an agent that only logs in, with no API-key section', () => {
    loadShared({
      settings: {
        acpAgents: [{ id: 'gemini', label: 'Gemini CLI', command: 'gemini', args: ['--acp'] }],
      },
    });
    seed();
    render(<AcpAccounts />);
    expect(screen.queryByTestId('acp-accounts-gemini')).toBeNull();
    expect(screen.getByTestId('acp-login-gemini-h1-status')).toHaveTextContent(
      'Not signed in on Mac',
    );
  });

  it('runs the sign-in: the address to open, the pasted redirect sent back, then signed in', async () => {
    seed(false);
    vi.spyOn(api, 'startAcpLogin').mockResolvedValue(view({ status: 'starting' }));
    const poll = vi
      .spyOn(api, 'acpLogin')
      .mockResolvedValueOnce(
        view({
          status: 'waiting',
          url: 'https://accounts.google.com/o/oauth2/auth?x=1',
          loopback: true,
        }),
      )
      .mockResolvedValue(view({ status: 'complete' }));
    const callback = vi.spyOn(api, 'acpLoginCallback').mockResolvedValue(
      view({
        status: 'waiting',
        url: 'https://accounts.google.com/o/oauth2/auth?x=1',
        loopback: true,
      }),
    );
    render(<AcpAccounts />);
    fireEvent.click(screen.getByTestId('acp-login-gemini-h1-start'));
    await waitFor(() => expect(screen.getByTestId('acp-login-gemini-h1-url')).toBeInTheDocument(), {
      timeout: 4000,
    });
    expect(screen.getByTestId('acp-login-gemini-h1-url')).toHaveAttribute(
      'href',
      'https://accounts.google.com/o/oauth2/auth?x=1',
    );
    expect(api.startAcpLogin).toHaveBeenCalledWith('gemini', 'h1', 'oauth-personal');
    fireEvent.change(screen.getByTestId('acp-login-gemini-h1-paste'), {
      target: { value: ' http://127.0.0.1:41234/oauth2callback?code=c ' },
    });
    fireEvent.click(screen.getByTestId('acp-login-gemini-h1-send'));
    await waitFor(() =>
      expect(callback).toHaveBeenCalledWith(
        'gemini',
        'l1',
        'http://127.0.0.1:41234/oauth2callback?code=c',
      ),
    );
    await waitFor(
      () =>
        expect(screen.getByTestId('acp-login-gemini-h1-status')).toHaveTextContent(
          'Signed in on Mac only',
        ),
      { timeout: 6000 },
    );
    expect(poll).toHaveBeenCalled();
  }, 20_000);

  it('a device code is shown; a failure says why; cancel stops it', async () => {
    seed(false);
    vi.spyOn(api, 'startAcpLogin').mockResolvedValue(
      view({ status: 'waiting', url: 'https://example.com/device', userCode: 'WXYZ-1234' }),
    );
    const cancel = vi.spyOn(api, 'cancelAcpLogin').mockResolvedValue(view({ status: 'cancelled' }));
    vi.spyOn(api, 'acpLogin').mockResolvedValue(
      view({ status: 'waiting', url: 'https://example.com/device', userCode: 'WXYZ-1234' }),
    );
    render(<AcpAccounts />);
    fireEvent.click(screen.getByTestId('acp-login-gemini-h1-start'));
    await waitFor(() =>
      expect(screen.getByTestId('acp-login-gemini-h1-code')).toHaveTextContent('Code: WXYZ-1234'),
    );
    expect(screen.queryByTestId('acp-login-gemini-h1-paste')).toBeNull();
    fireEvent.click(screen.getByTestId('acp-login-gemini-h1-cancel'));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('gemini', 'l1'));
    await waitFor(() =>
      expect(screen.getByTestId('acp-login-gemini-h1-status')).toHaveTextContent(
        'Sign-in cancelled',
      ),
    );
  });

  it('an offline host cannot start one; a refused start says the server’s words', async () => {
    seed(false);
    usePresenceStore.getState().setHostOnline('h1', false);
    const { unmount } = render(<AcpAccounts />);
    expect(screen.getByTestId('acp-login-gemini-h1-start')).toBeDisabled();
    unmount();
    usePresenceStore.getState().setHostOnline('h1', true);
    vi.spyOn(api, 'startAcpLogin').mockRejectedValue(
      new ApiError(409, 'login_running', {
        error: 'login_running',
        message: 'A sign-in to gemini is already running on Mac',
      }),
    );
    render(
      <>
        <AcpAccounts />
        <ErrorToasts />
      </>,
    );
    fireEvent.click(screen.getByTestId('acp-login-gemini-h1-start'));
    await waitFor(() => expect(screen.getByText(/already running on Mac/)).toBeInTheDocument());
  });
});
