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
  makeFetch,
  preferencesServer,
  renderSettings,
  resetSettingsState,
} from './settingsHarness.js';
import { loadShared, sharedState } from './sharedHelpers.js';
import { bedrockMonth } from '@patch/wire';

const errors = (): string[] => useUiStore.getState().errors.map((e) => e.message);

/** A row's action, opening its ⋯ menu first if it is shut. */
function action(menu: string, item: string): HTMLElement {
  if (!screen.queryByTestId(item)) fireEvent.click(screen.getByTestId(menu));
  return screen.getByTestId(item);
}

/** Add account → Claude subscription: the sign-in and setup-token controls. */
function addSubscription(): void {
  fireEvent.click(screen.getByTestId('add-claude-account'));
  fireEvent.click(screen.getByTestId('add-claude-subscription'));
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
  state: { state: 'ready' as const },
};
const PERSONAL = {
  id: 'acct-b',
  label: 'personal',
  connected: false,
  state: { state: 'signed_out' as const },
};
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
    // Usage is not known yet, so no status is claimed — least of all "Ready".
    expect(screen.getByTestId('account-claude-code-acct-a')).not.toHaveTextContent('Ready');
    expect(screen.queryByTestId('account-state-claude-code-acct-a')).toBeNull();
    expect(screen.getByTestId('account-state-claude-code-acct-b')).toHaveTextContent('Signed out');
    expect(screen.queryByTestId('settings-host-switch')).toBeNull();
  });

  it('says so when there are no accounts yet', () => {
    loadShared();
    renderSettings('/settings/usage');
    expect(screen.getByTestId('accounts-empty-claude-code')).toHaveTextContent(
      'No Claude accounts yet',
    );
    expect(screen.getByTestId('accounts-empty-codex')).toHaveTextContent('No ChatGPT accounts yet');
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
    // No ChatGPT accounts yet, so nothing to choose between.
    expect(screen.queryByTestId('strategy-codex-priority')).toBeNull();
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
    addSubscription();
    fireEvent.click(screen.getByTestId('add-claude-setup-token'));
    await waitFor(() => expect(useUiStore.getState().promptDialog).not.toBeNull());
    useUiStore.getState().resolvePrompt('  sk-ant-oat01-fake  ');
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith('claude-code', { token: 'sk-ant-oat01-fake' }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('account-claude-code-acct-a')).toBeInTheDocument(),
    );
  });

  it('signs in to Claude in the browser: opens claude.ai, takes the code back', async () => {
    loadShared();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    vi.spyOn(api, 'claudeSignInStart').mockResolvedValue({
      signInId: 's1',
      url: 'https://claude.com/cai/oauth/authorize?state=x',
      mode: 'code',
    });
    const complete = vi
      .spyOn(api, 'claudeSignInComplete')
      .mockResolvedValue(sharedState({ version: 2, secrets: { claude: [WORK] } }));
    renderSettings('/settings/usage');
    addSubscription();
    fireEvent.click(screen.getByTestId('claude-signin-start'));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        'https://claude.com/cai/oauth/authorize?state=x',
        '_blank',
        'noopener',
      ),
    );
    expect(await screen.findByTestId('claude-signin-reopen')).toHaveTextContent(
      'Open claude.ai again',
    );
    expect(screen.queryByTestId('claude-signin-hint')).toBeNull();
    fireEvent.change(await screen.findByTestId('claude-signin-code'), {
      target: { value: ' code#x ' },
    });
    fireEvent.click(screen.getByTestId('claude-signin-finish'));
    await waitFor(() => expect(complete).toHaveBeenCalledWith({ signInId: 's1', code: 'code#x' }));
    await waitFor(() =>
      expect(screen.getByTestId('account-claude-code-acct-a')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('claude-signin-code')).toBeNull();
  });

  it('a same-machine Claude sign-in needs no code: it waits, then the account appears', async () => {
    loadShared();
    vi.spyOn(window, 'open').mockReturnValue(null);
    vi.spyOn(api, 'claudeSignInStart').mockResolvedValue({
      signInId: 's1',
      url: 'https://x',
      mode: 'loopback',
    });
    const status = vi
      .spyOn(api, 'claudeSignInStatus')
      .mockResolvedValueOnce({ status: 'waiting' })
      .mockResolvedValue({ status: 'done' });
    vi.spyOn(api, 'sharedSettings').mockResolvedValue(
      sharedState({ version: 2, secrets: { claude: [WORK] } }),
    );
    renderSettings('/settings/usage');
    addSubscription();
    fireEvent.click(screen.getByTestId('claude-signin-start'));
    expect(await screen.findByTestId('claude-signin-wait')).toBeInTheDocument();
    expect(screen.queryByTestId('claude-signin-code')).toBeNull();
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2), { timeout: 4000 });
    await waitFor(() =>
      expect(screen.getByTestId('account-claude-code-acct-a')).toBeInTheDocument(),
    );
  });

  it('an expired Claude sign-in goes back to the start, saying so', async () => {
    loadShared();
    vi.spyOn(window, 'open').mockReturnValue(null);
    vi.spyOn(api, 'claudeSignInStart').mockResolvedValue({
      signInId: 's1',
      url: 'https://x',
      mode: 'code',
    });
    vi.spyOn(api, 'claudeSignInComplete').mockRejectedValue(
      new ApiError(410, 'signin_expired', {
        error: 'signin_expired',
        message: 'That sign-in has expired. Start it again.',
      }),
    );
    renderSettings('/settings/usage');
    addSubscription();
    fireEvent.click(screen.getByTestId('claude-signin-start'));
    fireEvent.change(await screen.findByTestId('claude-signin-code'), { target: { value: 'c' } });
    fireEvent.click(screen.getByTestId('claude-signin-finish'));
    expect(await screen.findByTestId('claude-signin-error')).toHaveTextContent('expired');
    expect(screen.getByTestId('claude-signin-start')).toBeInTheDocument();
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
    addSubscription();
    fireEvent.click(screen.getByTestId('add-claude-setup-token'));
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
    expect(useUiStore.getState().confirmDialog?.message).toContain('Every host stops using it');
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

  it('Refresh usage asks every online host to re-read now, and says so when none is online', () => {
    loadShared({ secrets: TWO });
    const send = vi.fn();
    setActiveWs({ send } as never);
    usePresenceStore.getState().setConnection('connected');
    reportHost('d1', { hostName: 'hetzner', runsManager: true });
    reportAccounts('d1', [{ id: 'acct-a', label: 'work', connected: true }] as never);
    usePresenceStore.getState().setHostOnline('d1', true);
    renderSettings('/settings/usage');
    fireEvent.click(
      action('account-menu-claude-code-acct-a', 'account-refresh-claude-code-acct-a'),
    );
    expect(send).toHaveBeenCalledWith({
      type: 'host.backend_usage_refresh',
      hostId: 'd1',
      backendId: 'claude-code',
    });
    send.mockClear();
    usePresenceStore.getState().setHostOnline('d1', false);
    fireEvent.click(
      action('account-menu-claude-code-acct-a', 'account-refresh-claude-code-acct-a'),
    );
    expect(send).not.toHaveBeenCalled();
    expect(errors().some((e) => e.includes('no online host'))).toBe(true);
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

  it('the ⋯ opens a panel whose actions say what they do', () => {
    loadShared({ secrets: TWO });
    renderSettings('/settings/usage');
    fireEvent.click(screen.getByTestId('account-menu-claude-code-acct-a'));
    const menu = screen.getByTestId('account-menu-claude-code-acct-a-open');
    expect(menu).toHaveAttribute('role', 'menu');
    expect(screen.getByTestId('account-refresh-claude-code-acct-a')).toHaveTextContent(
      'Refresh usage',
    );
    expect(screen.getByTestId('account-connect-claude-code-acct-a')).toHaveTextContent(
      'Sign in again',
    );
    expect(screen.getByTestId('account-connect-claude-code-acct-a')).toHaveTextContent(
      /in your browser/,
    );
    // Pasting a `claude setup-token` token stays beside the browser sign-in.
    expect(screen.getByTestId('account-paste-claude-code-acct-a')).toHaveTextContent(
      /claude setup-token/,
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
  const started = {
    signInId: 's1',
    userCode: 'ABCD-1234',
    url: 'https://auth.openai.com/codex/device',
    intervalSeconds: 1,
    expiresAt: Date.now() + 900_000,
  };

  it('starts on the server with no host online, and shows the code', async () => {
    loadShared();
    const start = vi.spyOn(api, 'chatgptSignInStart').mockResolvedValue(started);
    vi.spyOn(api, 'chatgptSignInStatus').mockResolvedValue({ status: 'pending' });
    renderSettings('/settings/usage');
    const button = screen.getByTestId('chatgpt-signin');
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByTestId('chatgpt-login-pending')).toHaveTextContent('ABCD-1234'),
    );
    expect(start).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('chatgpt-login-open')).toHaveAttribute('href', started.url);
    expect(screen.queryByTestId('chatgpt-no-host')).toBeNull();
  });

  it('opens the browser itself and offers a way out: try again or an API key', async () => {
    loadShared();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const start = vi.spyOn(api, 'chatgptSignInStart').mockResolvedValue(started);
    vi.spyOn(api, 'chatgptSignInStatus').mockResolvedValue({ status: 'pending' });
    vi.spyOn(api, 'chatgptSignInCancel').mockResolvedValue(undefined as never);
    renderSettings('/settings/usage');
    fireEvent.click(screen.getByTestId('chatgpt-signin'));
    await waitFor(() => expect(screen.getByTestId('chatgpt-login-pending')).toBeInTheDocument());
    expect(open).toHaveBeenCalledWith(started.url, '_blank', 'noopener');
    expect(screen.queryByTestId('chatgpt-add-api-key')).toBeNull();
    fireEvent.click(screen.getByTestId('chatgpt-signin-trouble'));
    expect(screen.getByTestId('chatgpt-add-api-key')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('chatgpt-signin-retry'));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  });

  it('applies the account once the server has the login', async () => {
    loadShared();
    vi.spyOn(api, 'chatgptSignInStart').mockResolvedValue(started);
    vi.spyOn(api, 'chatgptSignInStatus').mockResolvedValue({
      status: 'complete',
      state: sharedState({
        version: 2,
        secrets: {
          claude: [],
          codex: [{ id: 'cx1', label: 'me@example.com', kind: 'chatgpt', connected: true }],
        } as never,
      }),
    });
    renderSettings('/settings/usage');
    fireEvent.click(screen.getByTestId('chatgpt-signin'));
    await waitFor(
      () =>
        expect(usePreferencesStore.getState().shared?.secrets.codex.map((a) => a.id)).toContain(
          'cx1',
        ),
      { timeout: 4000 },
    );
    expect(screen.queryByTestId('chatgpt-login-pending')).toBeNull();
  });

  it('says why when the sign-in fails', async () => {
    loadShared();
    vi.spyOn(api, 'chatgptSignInStart').mockResolvedValue(started);
    vi.spyOn(api, 'chatgptSignInStatus').mockResolvedValue({
      status: 'failed',
      code: 'duplicate_account',
      error: 'This login is the same ChatGPT account as Work',
    });
    renderSettings('/settings/usage');
    fireEvent.click(screen.getByTestId('chatgpt-signin'));
    await waitFor(() => expect(screen.getByTestId('chatgpt-login-error')).toBeInTheDocument(), {
      timeout: 4000,
    });
    expect(screen.getByTestId('chatgpt-login-error')).toHaveTextContent(/same ChatGPT account/);
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

describe('Settings → Chats → snooze defaults', () => {
  it('shows 9 and 17 by default and writes a changed hour to the shared settings', async () => {
    const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    loadShared();
    renderSettings('/settings/chats');
    const morning = screen.getByTestId('snooze-morning-hour') as HTMLSelectElement;
    expect(morning.value).toBe('9');
    expect((screen.getByTestId('snooze-evening-hour') as HTMLSelectElement).value).toBe('17');
    fireEvent.change(morning, { target: { value: '7' } });
    await waitFor(() => expect(server.writes).toContainEqual({ snoozeMorningHour: 7 }));
    fireEvent.change(screen.getByTestId('snooze-evening-hour'), { target: { value: '18' } });
    await waitFor(() => expect(server.writes).toContainEqual({ snoozeEveningHour: 18 }));
  });
});

describe('Settings → Agent → when a turn hits a usage limit', () => {
  it('reads and writes the one shared limit behaviour', async () => {
    const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    loadShared({ settings: { limitBehaviour: 'other_account' } });
    renderSettings('/settings/agent');
    const select = (await screen.findByTestId('limit-behaviour-select')) as HTMLSelectElement;
    expect(select.value).toBe('other_account');
    expect([...select.options].map((o) => o.value)).toEqual([
      'resume_at_reset',
      'other_account',
      'switch_provider',
    ]);
    fireEvent.change(select, { target: { value: 'switch_provider' } });
    await waitFor(() =>
      expect(server.writes).toContainEqual({ limitBehaviour: 'switch_provider' }),
    );
    // The old on/off is gone: there is one setting.
    expect(screen.queryByTestId('auto-resume-rate-limit-toggle')).toBeNull();
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

describe('Settings → Usage → Auto and Amazon Bedrock accounts', () => {
  const month = bedrockMonth(Date.now());
  const WORK_BEDROCK = {
    id: 'b1',
    label: 'Work Bedrock',
    connected: true,
    auto: false,
    state: { state: 'ready' as const },
    bedrock: {
      hostId: 'd1',
      awsProfile: 'work-bedrock',
      awsRegion: 'eu-west-2',
      regionPrefix: 'auto' as const,
      monthlyCapUsd: 100,
      spentUsd: 18.42,
      spentMonth: month,
    },
  };
  const CLIENT_X = {
    ...WORK_BEDROCK,
    id: 'b2',
    label: 'Client X',
    connected: false,
    bedrock: {
      ...WORK_BEDROCK.bedrock,
      hostId: 'd2',
      awsProfile: 'client-x',
      awsRegion: 'us-east-1',
    },
  };
  function hosts(): void {
    reportHost('d1', {
      hostName: 'mac-mini',
      awsProfiles: [
        { name: 'default' },
        { name: 'work-bedrock', region: 'eu-west-2' },
        { name: 'client-x', region: 'us-east-1' },
      ],
    });
    reportHost('d2', { hostName: 'hetzner', awsProfiles: [] });
    reportHost('d3', { hostName: 'laptop' });
  }

  it('heads the list Auto | Account; unticked accounts sit last with no handle or rank', () => {
    loadShared({ secrets: { claude: [WORK, { ...PERSONAL, auto: false }] } });
    renderSettings('/settings/usage');
    expect(screen.getByTestId('accounts-head-claude-code')).toHaveTextContent('AutoAccount');
    expect(order('accounts-rank-claude-code')).toEqual(['acct-a', 'acct-b']);
    expect(screen.getByTestId('account-auto-claude-code-acct-a')).toBeChecked();
    expect(screen.getByTestId('account-auto-claude-code-acct-b')).not.toBeChecked();
    expect(screen.getByTestId('accounts-rank-claude-code-handle-acct-a')).toBeInTheDocument();
    expect(screen.queryByTestId('accounts-rank-claude-code-handle-acct-b')).toBeNull();
    const off = screen.getByTestId('account-claude-code-acct-b');
    expect(off.querySelector('.set-rank')).toBeNull();
    // ChatGPT accounts are all in the order: no checkbox, no header.
    expect(screen.queryByTestId('accounts-head-codex')).toBeNull();
  });

  it('ticking or unticking Auto writes `auto` for that account', async () => {
    loadShared({ secrets: TWO });
    const update = vi
      .spyOn(api, 'updateAccount')
      .mockResolvedValue(sharedState({ version: 2, secrets: { claude: [WORK, PERSONAL] } }));
    renderSettings('/settings/usage');
    fireEvent.click(screen.getByTestId('account-auto-claude-code-acct-a'));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('claude-code', 'acct-a', { auto: false }),
    );
  });

  it('a reorder names the accounts out of the order last', async () => {
    loadShared({ secrets: { claude: [WORK, PERSONAL, WORK_BEDROCK] } });
    const put = vi
      .spyOn(api, 'orderAccounts')
      .mockResolvedValue(sharedState({ version: 2, secrets: { claude: [WORK, PERSONAL] } }));
    renderSettings('/settings/usage');
    fireEvent.keyDown(screen.getByTestId('accounts-rank-claude-code-handle-acct-b'), {
      key: 'ArrowUp',
    });
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith('claude-code', ['acct-b', 'acct-a', 'b1']),
    );
  });

  it('a Bedrock row names its host, profile, region and the month’s spend against the cap', () => {
    hosts();
    loadShared({ secrets: { claude: [WORK, WORK_BEDROCK] } });
    renderSettings('/settings/usage');
    const row = screen.getByTestId('account-claude-code-b1');
    expect(row).toHaveTextContent('Work BedrockBedrock');
    expect(screen.getByTestId('account-bedrock-claude-code-b1-host')).toHaveTextContent(
      'Hostmac-mini',
    );
    expect(screen.getByTestId('account-bedrock-claude-code-b1-profile')).toHaveTextContent(
      'AWS profilework-bedrock',
    );
    expect(screen.getByTestId('account-bedrock-claude-code-b1-region')).toHaveTextContent(
      'Regioneu-west-2',
    );
    expect(screen.getByTestId('account-bedrock-claude-code-b1-monthly')).toHaveTextContent(
      /Monthly18%resets [A-Z][a-z]{2} 1$/,
    );
    expect(screen.getByTestId('account-bedrock-claude-code-b1-spent')).toHaveTextContent(
      'Spent$18.42 of $100 cap · estimated',
    );
    expect(screen.getByTestId('account-auto-claude-code-b1')).not.toBeChecked();
  });

  it('a signed-out Bedrock profile says so in place of the spend', () => {
    hosts();
    loadShared({ secrets: { claude: [WORK, CLIENT_X] } });
    renderSettings('/settings/usage');
    expect(screen.getByTestId('account-bedrock-claude-code-b2-status')).toHaveTextContent(
      'StatusAWS sign-in expired',
    );
    expect(screen.queryByTestId('account-bedrock-claude-code-b2-spent')).toBeNull();
    expect(screen.queryByTestId('account-bedrock-claude-code-b2-monthly')).toBeNull();
  });

  it('a Bedrock row’s ⋯ offers Edit and Remove, with no detail lines', () => {
    hosts();
    loadShared({ secrets: { claude: [WORK, WORK_BEDROCK] } });
    renderSettings('/settings/usage');
    fireEvent.click(screen.getByTestId('account-menu-claude-code-b1'));
    const menu = screen.getByTestId('account-menu-claude-code-b1-open');
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent)).toEqual([
      'Edit',
      'Remove',
    ]);
    expect(menu.querySelector('.set-acct-menu-detail')).toBeNull();
  });

  it('Add account opens a menu: Claude subscription or Amazon Bedrock', () => {
    loadShared({ secrets: TWO });
    renderSettings('/settings/usage');
    fireEvent.click(screen.getByTestId('add-claude-account'));
    expect(screen.getByTestId('add-claude-menu')).toHaveTextContent(
      'Claude subscriptionAmazon Bedrock',
    );
    fireEvent.click(screen.getByTestId('add-claude-subscription'));
    expect(screen.getByTestId('claude-signin-start')).toBeInTheDocument();
    expect(screen.getByTestId('add-claude-setup-token')).toBeInTheDocument();
  });

  it('adds a Bedrock account: hosts with AWS profiles, that host’s profiles, region from the profile', async () => {
    hosts();
    loadShared({ secrets: TWO });
    const add = vi
      .spyOn(api, 'addAccount')
      .mockResolvedValue(sharedState({ version: 2, secrets: { claude: [WORK, WORK_BEDROCK] } }));
    renderSettings('/settings/usage');
    fireEvent.click(screen.getByTestId('add-claude-account'));
    fireEvent.click(screen.getByTestId('add-claude-bedrock'));
    const form = screen.getByTestId('bedrock-form');
    expect(form).toHaveTextContent('Add Amazon Bedrock account');
    expect(screen.queryByTestId('add-claude-account')).toBeNull();
    // Only the hosts that report AWS profiles.
    expect(screen.getByTestId('bedrock-host-d1')).toHaveTextContent('mac-mini');
    expect(screen.getByTestId('bedrock-host-d2')).toHaveTextContent('hetzner');
    expect(screen.queryByTestId('bedrock-host-d3')).toBeNull();
    expect(screen.getByTestId('bedrock-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('bedrock-name'), { target: { value: 'Work Bedrock' } });
    fireEvent.click(screen.getByTestId('bedrock-host-d1'));
    fireEvent.click(screen.getByTestId('bedrock-profile-work-bedrock'));
    expect(screen.getByTestId('bedrock-region')).toHaveValue('eu-west-2');
    expect(screen.getByTestId('bedrock-prefix-auto')).toHaveTextContent('Auto (EU)');
    expect(screen.getByTestId('bedrock-prefix-auto')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(screen.getByTestId('bedrock-cap'), { target: { value: '$100' } });
    expect(screen.getByTestId('bedrock-auto')).not.toBeChecked();
    fireEvent.click(screen.getByTestId('bedrock-submit'));
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith('claude-code', {
        bedrock: {
          label: 'Work Bedrock',
          hostId: 'd1',
          awsProfile: 'work-bedrock',
          awsRegion: 'eu-west-2',
          regionPrefix: 'auto',
          monthlyCapUsd: 100,
          auto: false,
        },
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('bedrock-form')).toBeNull());
    expect(screen.getByTestId('account-claude-code-b1')).toBeInTheDocument();
  });

  it('keeps the form open and says why when the server refuses the profile', async () => {
    hosts();
    loadShared({ secrets: TWO });
    vi.spyOn(api, 'addAccount').mockRejectedValue(
      new ApiError(409, 'host_offline', { error: 'host_offline', message: 'mac-mini is offline' }),
    );
    renderSettings('/settings/usage');
    fireEvent.click(screen.getByTestId('add-claude-account'));
    fireEvent.click(screen.getByTestId('add-claude-bedrock'));
    fireEvent.change(screen.getByTestId('bedrock-name'), { target: { value: 'Work' } });
    // It starts on the first host with a profile; one with none says so.
    expect(screen.getByTestId('bedrock-host-d1')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('bedrock-host-d2'));
    expect(screen.getByTestId('bedrock-no-profiles')).toHaveTextContent(
      'hetzner has no AWS profiles',
    );
    fireEvent.click(screen.getByTestId('bedrock-host-d1'));
    fireEvent.click(screen.getByTestId('bedrock-profile-work-bedrock'));
    fireEvent.change(screen.getByTestId('bedrock-cap'), { target: { value: '50' } });
    fireEvent.click(screen.getByTestId('bedrock-submit'));
    await waitFor(() => expect(errors().some((e) => e.includes('mac-mini is offline'))).toBe(true));
    expect(screen.getByTestId('bedrock-form')).toBeInTheDocument();
  });

  it('Edit opens the form filled in and writes only what changed', async () => {
    hosts();
    loadShared({ secrets: { claude: [WORK, WORK_BEDROCK] } });
    const update = vi
      .spyOn(api, 'updateAccount')
      .mockResolvedValue(sharedState({ version: 2, secrets: { claude: [WORK, WORK_BEDROCK] } }));
    renderSettings('/settings/usage');
    fireEvent.click(action('account-menu-claude-code-b1', 'account-edit-claude-code-b1'));
    expect(screen.getByTestId('bedrock-name')).toHaveValue('Work Bedrock');
    expect(screen.getByTestId('bedrock-profile-work-bedrock')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('bedrock-cap')).toHaveValue('$100');
    fireEvent.change(screen.getByTestId('bedrock-cap'), { target: { value: '250' } });
    fireEvent.click(screen.getByTestId('bedrock-prefix-eu'));
    fireEvent.click(screen.getByTestId('bedrock-submit'));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('claude-code', 'b1', {
        regionPrefix: 'eu',
        monthlyCapUsd: 250,
      }),
    );
  });
});
