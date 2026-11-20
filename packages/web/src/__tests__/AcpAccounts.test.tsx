// Settings → AI accounts → ACP agents (spec/10 § Backend credentials, § Signing
// in). An ACP agent signs in with an API key the server checks and stores; the
// page shows each account's last four and state, never the key, and every
// change settles on the server's answer.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AcpAccounts } from '../routes/settings/AcpAccounts.js';
import { ErrorToasts } from '../components/ErrorToasts.js';
import { ConfirmModal } from '../components/ConfirmModal.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api, ApiError } from '../api/rest.js';
import { clearHosts } from './presenceHelpers.js';
import { loadShared, resetShared, sharedState } from './sharedHelpers.js';

const KEY = 'AIzaFakeGeminiKeyForTests00001111';
const WORK = {
  id: 'a1',
  agentId: 'gemini',
  label: 'Work',
  last4: '1111',
  state: { state: 'ready' as const },
};

function renderIt(): void {
  render(
    <>
      <AcpAccounts />
      <ErrorToasts />
      <ConfirmModal />
    </>,
  );
}

describe('Settings → AI accounts → ACP agents', () => {
  beforeEach(() => {
    clearHosts();
    resetShared();
    useUiStore.getState().clearToasts();
    useUiStore.getState().resolveConfirm(false);
    usePresenceStore.getState().setConnection('connected');
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows Gemini CLI with no accounts, and an agent that takes no key not at all', () => {
    loadShared({
      settings: { acpAgents: [{ id: 'local', label: 'Local agent', command: 'x', args: [] }] },
    });
    renderIt();
    expect(screen.getByTestId('acp-accounts-gemini-empty')).toHaveTextContent('No accounts');
    expect(screen.queryByTestId('acp-accounts-local')).toBeNull();
  });

  it('lists an account with its last four and state, never the key', () => {
    loadShared({ secrets: { acp: [WORK] } });
    renderIt();
    const row = screen.getByTestId('acp-account-a1');
    expect(row).toHaveTextContent('Work');
    expect(row).toHaveTextContent('API key · ends 1111 · Ready');
  });

  it('adds an account from a pasted key and settles on the server answer', async () => {
    loadShared();
    const add = vi
      .spyOn(api, 'addAcpAccount')
      .mockResolvedValue(sharedState({ secrets: { acp: [WORK] } }));
    renderIt();
    fireEvent.click(screen.getByTestId('acp-accounts-gemini-add'));
    fireEvent.change(screen.getByTestId('acp-accounts-gemini-input'), {
      target: { value: ` ${KEY} ` },
    });
    fireEvent.click(screen.getByTestId('acp-accounts-gemini-save'));
    await waitFor(() => expect(screen.getByTestId('acp-account-a1')).toBeInTheDocument());
    expect(add).toHaveBeenCalledWith('gemini', KEY);
    expect(screen.queryByTestId('acp-accounts-gemini-input')).toBeNull();
  });

  it('says why a key was refused, in the server words, and keeps the field open', async () => {
    loadShared();
    vi.spyOn(api, 'addAcpAccount').mockRejectedValue(
      new ApiError(400, 'credential_rejected', {
        error: 'credential_rejected',
        message: 'The provider refused this key (HTTP 400)',
      }),
    );
    renderIt();
    fireEvent.click(screen.getByTestId('acp-accounts-gemini-add'));
    fireEvent.change(screen.getByTestId('acp-accounts-gemini-input'), { target: { value: KEY } });
    fireEvent.click(screen.getByTestId('acp-accounts-gemini-save'));
    await waitFor(() =>
      expect(screen.getByText(/The provider refused this key/)).toBeInTheDocument(),
    );
    expect(screen.getByTestId('acp-accounts-gemini-input')).toBeInTheDocument();
  });

  it('gives an account a new key, and removes one after confirming', async () => {
    loadShared({ secrets: { acp: [WORK] } });
    const replace = vi
      .spyOn(api, 'replaceAcpKey')
      .mockResolvedValue(sharedState({ secrets: { acp: [{ ...WORK, last4: '2222' }] } }));
    const remove = vi
      .spyOn(api, 'removeAcpAccount')
      .mockResolvedValue(sharedState({ secrets: {} }));
    renderIt();
    fireEvent.click(screen.getByTestId('acp-account-a1-replace'));
    fireEvent.change(screen.getByTestId('acp-accounts-gemini-input'), { target: { value: KEY } });
    fireEvent.click(screen.getByTestId('acp-accounts-gemini-save'));
    await waitFor(() =>
      expect(screen.getByTestId('acp-account-a1')).toHaveTextContent('ends 2222'),
    );
    expect(replace).toHaveBeenCalledWith('gemini', 'a1', KEY);

    fireEvent.click(screen.getByTestId('acp-account-a1-remove'));
    await waitFor(() => expect(useUiStore.getState().confirmDialog).not.toBeNull());
    useUiStore.getState().resolveConfirm(true);
    await waitFor(() => expect(remove).toHaveBeenCalledWith('gemini', 'a1'));
    await waitFor(() =>
      expect(screen.getByTestId('acp-accounts-gemini-empty')).toBeInTheDocument(),
    );
  });
});
