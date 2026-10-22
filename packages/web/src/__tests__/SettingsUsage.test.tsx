// Settings → Usage (spec/10 § Backend credentials, spec/01 § Settings): the
// Claude and ChatGPT accounts every host draws from, ranked, with the strategy
// that picks among them, each account's freshest usage reading from any host,
// and whether a limited turn resumes by itself.
//
// The accounts are shared settings: every change is a server write that
// settles on the committed state. A host adds only its view of each account.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { api, ApiError } from '../api/rest.js';
import { reportAccounts, reportHost } from './presenceHelpers.js';
import { setActiveWs } from '../api/ws.js';
import {
  fakeWs,
  makeFetch,
  preferencesServer,
  renderSettings,
  resetSettingsState,
} from './settingsHarness.js';
import { loadShared, sharedState } from './sharedHelpers.js';

const errors = (): string[] => useUiStore.getState().errors.map((e) => e.message);

/** A row's action, opening its ⋯ menu first if it is shut. */
function action(menu: string, item: string): HTMLElement {
  if (!screen.queryByTestId(item)) fireEvent.click(screen.getByTestId(menu));
  return screen.getByTestId(item);
}

/** The order a ranked list is drawn in, by account id. */
function order(list: string): string[] {
  const prefix = `${list}-item-`;
  return Array.from(document.querySelectorAll(`[data-testid^="${prefix}"]`)).map((el) =>
    (el.getAttribute('data-testid') ?? '').slice(prefix.length),
  );
}

const WORK = {
  id: 'acct-a',
  label: 'work',
  connected: true,
  email: 'work@example.com',
  organizationId: 'org-a',
};
const PERSONAL = { id: 'acct-b', label: 'personal', connected: false };
const TWO = { claude: [WORK, PERSONAL] };

beforeEach(() => {
  resetSettingsState();
  vi.stubGlobal('fetch', makeFetch());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setActiveWs(null);
});

describe('Settings → Usage → accounts', () => {
  it('says it is loading until the shared settings arrive', () => {
    renderSettings('/settings/usage');
    expect(screen.getByTestId('accounts-loading-claude-code')).toBeInTheDocument();
  });

  it('lists the shared accounts in order, with no host switcher — they are every host’s', () => {
    loadShared({ secrets: TWO });
    reportHost('d1', { hostName: 'hetzner' });
    reportHost('d2', { hostName: 'mac', runsManager: false });
    renderSettings('/settings/usage');
    expect(order('accounts-rank-claude-code')).toEqual(['acct-a', 'acct-b']);
    expect(screen.getByTestId('account-claude-code-acct-a')).toHaveTextContent('work');
    expect(screen.getByTestId('account-claude-code-acct-a')).toHaveTextContent('work@example.com');
    expect(screen.getByTestId('account-claude-code-acct-b')).toHaveTextContent('Signed out');
    expect(screen.queryByTestId('settings-host-switch')).toBeNull();
  });

  it('says so when there are no accounts yet', () => {
    loadShared();
    renderSettings('/settings/usage');
    expect(screen.getByTestId('accounts-empty-claude-code')).toHaveTextContent(
      'No Claude accounts yet',
    );
    expect(screen.getByTestId('accounts-empty-codex')).toHaveTextContent('No Codex accounts yet');
  });

  it('shows the freshest usage reading any host has taken, and names no host', () => {
    loadShared({ secrets: TWO });
    reportHost('d1', { hostName: 'hetzner' });
    reportHost('d2', { hostName: 'mac', runsManager: false });
    const older = { at: 1_000, session: { status: 'allowed' as const, utilization: 0.1 } };
    const newer = { at: 2_000, session: { status: 'allowed' as const, utilization: 0.7 } };
    reportAccounts('d1', [{ id: 'acct-a', label: 'work', connected: true, usage: older }]);
    reportAccounts('d2', [{ id: 'acct-a', label: 'work', connected: true, usage: newer }]);
    renderSettings('/settings/usage');
    expect(screen.getByTestId('account-usage-session-claude-code-acct-a')).toHaveTextContent('70%');
    expect(screen.getByTestId('account-claude-code-acct-a')).not.toHaveTextContent(/on mac/);
    expect(screen.getByTestId('account-claude-code-acct-a')).not.toHaveTextContent(/hetzner/);
    // How old the reading is sits beside the name, not in the sub-line.
    const read = screen.getByTestId('account-read-claude-code-acct-a');
    expect(read.closest('.set-row-title')).not.toBeNull();
    expect(read).not.toHaveTextContent(/read/);
  });

  it('puts the extra-usage reason on its own line, linked to where it is turned on', () => {
    loadShared({ secrets: TWO });
    reportHost('d1', { hostName: 'hetzner' });
    reportAccounts('d1', [
      {
        id: 'acct-a',
        label: 'work',
        connected: true,
        usage: {
          at: 1_000,
          session: { status: 'allowed', utilization: 0.1 },
          overage: { status: 'rejected', disabledReason: 'org_level_disabled_until' },
        },
      },
    ]);
    renderSettings('/settings/usage');
    const overage = screen.getByTestId('account-usage-overage-claude-code-acct-a');
    expect(overage).toHaveTextContent('Extra usage');
    expect(overage).toHaveTextContent('off');
    expect(overage).toHaveClass('off');
    expect(screen.getByTestId('account-extra-usage-settings')).toHaveAttribute(
      'href',
      'https://claude.ai/settings/usage',
    );
    expect(overage).toContainElement(screen.getByTestId('account-extra-usage-settings'));
  });

  it('warns when two accounts are the same Claude account', () => {
    loadShared({
      secrets: { claude: [WORK, { ...PERSONAL, connected: true, organizationId: 'org-a' }] },
    });
    renderSettings('/settings/usage');
    expect(screen.getByTestId('account-twin-claude-code-acct-b')).toHaveTextContent(
      'Same Claude account as work',
    );
  });
});

describe('Settings → Usage → strategy', () => {
  it('shows each backend’s strategy and writes a change to the server', async () => {
    loadShared({ secrets: TWO });
    const set = vi.spyOn(api, 'setAccountStrategy').mockResolvedValue(
      sharedState({
        version: 2,
        secrets: TWO,
        settings: { accountStrategy: { claude: 'round-robin', codex: 'priority' } },
      }),
    );
    renderSettings('/settings/usage');
    expect(screen.getByTestId('strategy-claude-code-priority')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('strategy-claude-code-least-used')).toHaveTextContent('Least used');
    fireEvent.click(screen.getByTestId('strategy-claude-code-round-robin'));
    await waitFor(() => expect(set).toHaveBeenCalledWith('claude-code', 'round-robin'));
    await waitFor(() =>
      expect(screen.getByTestId('strategy-claude-code-round-robin')).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    expect(screen.getByTestId('strategy-codex-priority')).toHaveAttribute('aria-pressed', 'true');
  });

  it('says what each strategy does on hover', () => {
    loadShared({ secrets: TWO });
    renderSettings('/settings/usage');
    expect(screen.getByTestId('strategy-claude-code-round-robin')).toHaveAttribute(
      'title',
      expect.stringMatching(/next account along/),
    );
    expect(screen.getByTestId('strategy-claude-code-priority')).toHaveAttribute(
      'title',
      expect.stringMatching(/first account/i),
    );
  });
});

describe('Settings → Usage → changing accounts', () => {
  it('adds a Claude account from a pasted token', async () => {
    loadShared();
    const add = vi
      .spyOn(api, 'addAccount')
      .mockResolvedValue(sharedState({ version: 2, secrets: { claude: [WORK] } }));
    renderSettings('/settings/usage');
    fireEvent.click(screen.getByTestId('add-claude-account'));
    await waitFor(() => expect(useUiStore.getState().promptDialog).not.toBeNull());
    useUiStore.getState().resolvePrompt('  sk-ant-oat01-fake  ');
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith('claude-code', { token: 'sk-ant-oat01-fake' }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('account-claude-code-acct-a')).toBeInTheDocument(),
    );
  });

  it('says why the server refused a token, in its own words', async () => {
    loadShared();
    vi.spyOn(api, 'addAccount').mockRejectedValue(
      new ApiError(400, 'credential_rejected', {
        error: 'credential_rejected',
        message: 'Anthropic rejected this token (HTTP 401)',
      }),
    );
    renderSettings('/settings/usage');
    fireEvent.click(screen.getByTestId('add-claude-account'));
    await waitFor(() => expect(useUiStore.getState().promptDialog).not.toBeNull());
    useUiStore.getState().resolvePrompt('sk-ant-oat01-bad');
    await waitFor(() =>
      expect(errors().some((e) => e.includes('Anthropic rejected this token'))).toBe(true),
    );
  });

  it('names no host anywhere on the page: an account is every host’s', () => {
    loadShared({ secrets: TWO });
    reportHost('d1', { hostName: 'hetzner' });
    usePresenceStore.getState().setHostOnline('d1', true);
    reportHost('d2', { hostName: 'mac', runsManager: false });
    usePresenceStore.getState().setHostOnline('d2', true);
    renderSettings('/settings/usage');
    expect(screen.queryByTestId('adopt-claude-d1')).toBeNull();
    expect(screen.getByTestId('settings-usage')).not.toHaveTextContent(/hetzner|\bmac\b/);
  });

  it('sign out asks first, then signs out for every host', async () => {
    loadShared({ secrets: TWO });
    const disc = vi.spyOn(api, 'disconnectAccount').mockResolvedValue(sharedState({ version: 2 }));
    renderSettings('/settings/usage');
    fireEvent.click(
      action('account-menu-claude-code-acct-a', 'account-disconnect-claude-code-acct-a'),
    );
    await waitFor(() => expect(useUiStore.getState().confirmDialog).not.toBeNull());
    expect(useUiStore.getState().confirmDialog?.message).toContain('Every machine stops using it');
    expect(disc).not.toHaveBeenCalled();
    useUiStore.getState().resolveConfirm(true);
    await waitFor(() => expect(disc).toHaveBeenCalledWith('claude-code', 'acct-a'));
  });

  it('a cancelled remove sends nothing', async () => {
    loadShared({ secrets: TWO });
    const remove = vi.spyOn(api, 'removeAccount');
    renderSettings('/settings/usage');
    fireEvent.click(action('account-menu-claude-code-acct-b', 'account-remove-claude-code-acct-b'));
    await waitFor(() => expect(useUiStore.getState().confirmDialog).not.toBeNull());
    useUiStore.getState().resolveConfirm(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(remove).not.toHaveBeenCalled();
  });

  it('reorders by keyboard and settles on the server’s order', async () => {
    loadShared({ secrets: TWO });
    const orderCall = vi
      .spyOn(api, 'orderAccounts')
      .mockResolvedValue(sharedState({ version: 2, secrets: { claude: [PERSONAL, WORK] } }));
    renderSettings('/settings/usage');
    fireEvent.keyDown(screen.getByTestId('accounts-rank-claude-code-handle-acct-b'), {
      key: 'ArrowUp',
    });
    await waitFor(() =>
      expect(orderCall).toHaveBeenCalledWith('claude-code', ['acct-b', 'acct-a']),
    );
    await waitFor(() => expect(order('accounts-rank-claude-code')).toEqual(['acct-b', 'acct-a']));
  });

  it('a refused reorder goes back to the committed order and says why', async () => {
    loadShared({ secrets: TWO });
    vi.spyOn(api, 'orderAccounts').mockRejectedValue(
      new ApiError(400, 'invalid_order', {
        error: 'invalid_order',
        message: 'The order must name each account exactly once',
      }),
    );
    renderSettings('/settings/usage');
    fireEvent.keyDown(screen.getByTestId('accounts-rank-claude-code-handle-acct-b'), {
      key: 'ArrowUp',
    });
    await waitFor(() => expect(errors().some((e) => e.includes('exactly once'))).toBe(true));
    expect(order('accounts-rank-claude-code')).toEqual(['acct-a', 'acct-b']);
  });

  it('the ⋯ opens a panel whose actions say what they do, with no refresh', () => {
    loadShared({ secrets: TWO });
    renderSettings('/settings/usage');
    fireEvent.click(screen.getByTestId('account-menu-claude-code-acct-a'));
    const menu = screen.getByTestId('account-menu-claude-code-acct-a-open');
    expect(menu).toHaveAttribute('role', 'menu');
    expect(screen.queryByTestId('account-refresh-claude-code-acct-a')).toBeNull();
    expect(screen.getByTestId('account-connect-claude-code-acct-a')).toHaveTextContent(
      'Sign in again',
    );
    expect(screen.getByTestId('account-connect-claude-code-acct-a')).toHaveTextContent(
      /fresh token/,
    );
    expect(screen.getByTestId('account-disconnect-claude-code-acct-a')).toHaveTextContent(
      'Sign out',
    );
    expect(screen.getByTestId('account-disconnect-claude-code-acct-a')).toHaveTextContent(
      /forget the login/,
    );
    expect(screen.getByTestId('account-remove-claude-code-acct-a')).toHaveTextContent(/everywhere/);
    // A signed-out row offers Sign in, and nothing to sign out of.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('account-menu-claude-code-acct-a-open')).toBeNull();
    fireEvent.click(screen.getByTestId('account-menu-claude-code-acct-b'));
    expect(screen.getByTestId('account-connect-claude-code-acct-b')).toHaveTextContent(/^Sign in/);
    expect(screen.queryByTestId('account-disconnect-claude-code-acct-b')).toBeNull();
  });
});

describe('Settings → Usage → ChatGPT sign-in', () => {
  it('runs a ChatGPT sign-in on the chosen online host', () => {
    loadShared();
    reportHost('d1', { hostName: 'hetzner' });
    usePresenceStore.getState().setHostOnline('d1', true);
    const { sent } = fakeWs();
    renderSettings('/settings/usage');
    fireEvent.click(screen.getByTestId('chatgpt-signin'));
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: 'host.backend_add_account',
        hostId: 'd1',
        backendId: 'codex',
        authMethod: 'device',
      }),
    );
  });

  it('shows the code while the sign-in waits', () => {
    loadShared();
    reportHost('d1', { hostName: 'hetzner' });
    usePresenceStore.getState().setHostOnline('d1', true);
    usePresenceStore.getState().setHostAccount({
      type: 'host.account',
      hostId: 'd1',
      backendId: 'codex',
      connected: false,
      accountEmail: null,
      login: {
        requestId: 'r1',
        status: 'pending',
        code: 'ABCD-1234',
        url: 'https://auth.openai.com/device',
      },
    });
    renderSettings('/settings/usage');
    expect(screen.getByTestId('chatgpt-login-pending')).toHaveTextContent('ABCD-1234');
  });

  it('says there is nowhere to sign in while no host is online', () => {
    loadShared();
    renderSettings('/settings/usage');
    expect(screen.getByTestId('chatgpt-no-host')).toBeInTheDocument();
    expect(screen.getByTestId('chatgpt-signin')).toBeDisabled();
  });
});

describe('Settings → Chats → token-spending generation', () => {
  it('title and status toggles live on Chats, not Usage, and write the shared settings', async () => {
    const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    loadShared({ settings: { titleGenerationEnabled: true, statusGenerationEnabled: true } });
    renderSettings('/settings/usage');
    expect(screen.queryByTestId('title-generation-toggle')).toBeNull();
    renderSettings('/settings/chats');
    const title = screen.getByTestId('title-generation-toggle');
    expect(title).toBeChecked();
    fireEvent.click(title);
    await waitFor(() => expect(server.writes).toContainEqual({ titleGenerationEnabled: false }));
    fireEvent.click(screen.getByTestId('status-generation-toggle'));
    await waitFor(() => expect(server.writes).toContainEqual({ statusGenerationEnabled: false }));
  });
});

describe('Settings → Usage → auto-resume', () => {
  it('reads and writes the shared setting', async () => {
    const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    loadShared({ settings: { autoResumeRateLimit: true } });
    renderSettings('/settings/usage');
    const toggle = screen.getByTestId('auto-resume-rate-limit-toggle');
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(server.writes).toContainEqual({ autoResumeRateLimit: false }));
  });
});

describe('Settings → Account → sync position', () => {
  it('reads and writes the shared setting', async () => {
    const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    loadShared({ settings: { syncPosition: true } });
    renderSettings('/settings/account');
    const toggle = screen.getByTestId('sync-position-toggle');
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(server.writes).toContainEqual({ syncPosition: false }));
  });
});
