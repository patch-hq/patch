// Settings → Usage on mobile (spec/10 § Backend credentials, spec/01 §
// Settings): the Claude and ChatGPT accounts every host draws from, ranked,
// with the strategy that picks among them and each account's freshest usage
// reading from any host. Every change is a server write that settles on the
// committed shared state; a ChatGPT sign-in runs on one online host.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';
import { act } from 'react-test-renderer';
import { bedrockMonth, DEFAULT_SHARED_SETTINGS } from '@patch/wire';
import { STRATEGY_HINT, UsagePage } from '../src/components/settings/CreditSourcesSection';
import { PROVIDERS } from '../src/components/settings/providers';
import {
  renderRN,
  findHost,
  queryHost,
  byTestId,
  textOf,
  actAsync,
  flush,
} from './testUtils/render';
import { __getLastAlert, __clearLastAlert } from './stubs/react-native';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useSettingsStore } from '../src/stores/settingsStore';
import { api } from '../src/api/rest';
import { pressMenuItem, reportHost, resetHosts, seedSettings } from './testUtils/settingsFixtures';

const send = vi.fn();
vi.mock('../src/api/ws', () => ({ getWs: vi.fn(() => ({ send })) }));
vi.mock('../src/api/rest', () => ({
  api: {
    setPreferences: vi.fn(),
    addAccount: vi.fn(),
    addBedrockAccount: vi.fn(),
    updateAccount: vi.fn(),
    disconnectAccount: vi.fn(),
    removeAccount: vi.fn(),
    orderAccounts: vi.fn(),
    setAccountStrategy: vi.fn(),
    adoptAccount: vi.fn(),
    usageReport: vi.fn(),
    chatgptSignInStart: vi.fn(),
    chatgptSignInStatus: vi.fn(),
    chatgptSignInCancel: vi.fn(),
    claudeSignInStart: vi.fn(),
    claudeSignInComplete: vi.fn(),
  },
}));

const WORK = {
  id: 'a',
  label: 'work',
  connected: true,
  email: 'work@example.com',
  organizationId: 'org-a',
  state: { state: 'ready' as const },
};
const PERSONAL = {
  id: 'b',
  label: 'personal',
  connected: false,
  state: { state: 'signed_out' as const },
};

function shared(claude = [WORK, PERSONAL], strategy: 'priority' | 'round-robin' = 'priority') {
  return {
    version: 2,
    settings: {
      ...DEFAULT_SHARED_SETTINGS,
      accountStrategy: { claude: strategy, codex: 'priority' as const },
    },
    secrets: { claude, codex: [], providerKeys: [] },
    hosts: [],
  };
}

const mounted: ReactTestRenderer[] = [];
async function render(): Promise<ReactTestRenderer> {
  const r = renderRN(<UsagePage />);
  mounted.push(r);
  await flush();
  return r;
}
const get = (r: ReactTestRenderer, id: string) => findHost(r.root, byTestId(id));
const query = (r: ReactTestRenderer, id: string) => queryHost(r.root, byTestId(id));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.usageReport).mockResolvedValue({ samples: [], chats: [] });
  __clearLastAlert();
  resetHosts();
  seedSettings({
    shared: {
      version: 1,
      secrets: { claude: [WORK, PERSONAL], codex: [], providerKeys: [] },
      hosts: [],
    },
  });
});
afterEach(() => {
  act(() => {
    for (const r of mounted.splice(0)) r.unmount();
  });
});

describe('mobile Settings → Usage — the shared accounts', () => {
  it('lists the accounts in order, with no host switcher', async () => {
    const r = await render();
    expect(textOf(get(r, 'account-claude-code-a'))).toContain('work');
    expect(textOf(get(r, 'account-claude-code-a'))).toContain('work@example.com');
    expect(textOf(get(r, 'account-claude-code-a'))).toContain('Ready');
    expect(textOf(get(r, 'account-claude-code-b'))).toContain('Signed out');
    expect(query(r, 'host-switcher')).toBeNull();
  });

  it('says so while settings have not loaded, and when there are no accounts', async () => {
    useSettingsStore.getState()._reset();
    const r1 = await render();
    expect(query(r1, 'usage-loading')).not.toBeNull();
    useSettingsStore.setState({ error: 'no answer from the server after 10s' });
    const rErr = await render();
    expect(textOf(get(rErr, 'usage-error'))).toContain('no answer from the server');
    expect(query(rErr, 'usage-loading')).toBeNull();
    useSettingsStore.getState()._reset();
    seedSettings();
    const r2 = await render();
    expect(textOf(get(r2, 'accounts-empty-codex'))).toContain('No Codex accounts yet');
  });

  it('shows the freshest usage reading any host took', async () => {
    reportHost('h1', { hostName: 'hetzner' });
    reportHost('h2', { hostName: 'mac', runsManager: false });
    const report = (hostId: string, utilization: number, at: number) =>
      usePresenceStore.getState().setHostAccount({
        type: 'host.account',
        hostId,
        backendId: 'claude-code',
        connected: true,
        accountEmail: null,
        accounts: [
          {
            id: 'a',
            label: 'work',
            connected: true,
            accountEmail: null,
            usage: { at, session: { status: 'allowed', utilization } },
          },
        ],
      });
    report('h1', 0.1, 1_000);
    report('h2', 0.7, 2_000);
    const r = await render();
    expect(textOf(get(r, 'account-claude-code-a'))).not.toMatch(/mac|hetzner|\bread on\b/);
    expect(textOf(get(r, 'account-claude-code-a-usage-session'))).toContain('70%');
  });

  it('writes a new strategy to the server and shows the answer', async () => {
    vi.mocked(api.setAccountStrategy).mockResolvedValue(shared(undefined, 'round-robin'));
    const r = await render();
    expect(get(r, 'strategy-claude-code-priority').props.accessibilityState.selected).toBe(true);
    await actAsync(async () => {
      get(r, 'strategy-claude-code-round-robin').props.onPress();
      await flush();
    });
    expect(api.setAccountStrategy).toHaveBeenCalledWith('claude-code', 'round-robin');
    expect(get(r, 'strategy-claude-code-round-robin').props.accessibilityState.selected).toBe(true);
  });

  it('moves an account down, and settles on the server’s order', async () => {
    vi.mocked(api.orderAccounts).mockResolvedValue(shared([PERSONAL, WORK]));
    const r = await render();
    await pressMenuItem(r.root, 'account-claude-code-a-menu', 'account-claude-code-a-down');
    await flush();
    expect(api.orderAccounts).toHaveBeenCalledWith('claude-code', ['b', 'a']);
  });

  it('sign out asks first, then signs the account out', async () => {
    vi.mocked(api.disconnectAccount).mockResolvedValue(
      shared([{ ...WORK, connected: false }, PERSONAL]),
    );
    const r = await render();
    await pressMenuItem(r.root, 'account-claude-code-a-menu', 'account-claude-code-a-disconnect');
    expect(__getLastAlert()?.message).toContain('Nothing uses it until it is signed in again');
    expect(api.disconnectAccount).not.toHaveBeenCalled();
    await actAsync(async () => {
      __getLastAlert()!.buttons!.find((b) => b.text === 'Sign out')!.onPress!();
      await flush();
    });
    expect(api.disconnectAccount).toHaveBeenCalledWith('claude-code', 'a');
  });

  it('adds a Claude account from a pasted token, and says a refusal in the server’s words', async () => {
    vi.mocked(api.addAccount).mockRejectedValue(
      Object.assign(new Error('HTTP 400'), {
        body: { message: 'Anthropic rejected this token (HTTP 401)' },
      }),
    );
    const r = await render();
    await actAsync(() => get(r, 'add-claude-account').props.onPress());
    await actAsync(() => get(r, 'add-claude-token').props.onChangeText(' sk-ant-oat01-x '));
    await actAsync(async () => {
      get(r, 'add-claude-submit').props.onPress();
      await flush();
    });
    expect(api.addAccount).toHaveBeenCalledWith('claude-code', { token: 'sk-ant-oat01-x' });
    expect(__getLastAlert()?.message).toBe('Anthropic rejected this token (HTTP 401)');
  });

  it('names no host anywhere on the page, and has no per-host login or refresh action', async () => {
    reportHost('h1', { hostName: 'hetzner' });
    reportHost('h2', { hostName: 'mac' });
    const r = await render();
    expect(query(r, 'adopt-claude-h1')).toBeNull();
    expect(query(r, 'adopt-claude-h2')).toBeNull();
    const all = textOf(r.root);
    expect(all).not.toMatch(/hetzner|netcup|\bmac\b|Use the login on/i);
    await actAsync(() => get(r, 'account-claude-code-a-menu').props.onPress());
    expect(query(r, 'account-claude-code-a-refresh')).toBeNull();
  });

  it('explains each account action in one line, and offers Rename', async () => {
    const r = await render();
    await actAsync(() => get(r, 'account-claude-code-a-menu').props.onPress());
    expect(textOf(get(r, 'account-claude-code-a-rename'))).toContain('Rename');
    expect(textOf(get(r, 'account-claude-code-a-connect'))).toContain('Sign in again');
    expect(textOf(get(r, 'account-claude-code-a-connect'))).toContain('Replace the stored login');
    expect(textOf(get(r, 'account-claude-code-a-disconnect'))).toContain('Keep the row, forget');
    expect(textOf(get(r, 'account-claude-code-a-remove'))).toContain('Remove');
    expect(textOf(get(r, 'account-claude-code-a-remove'))).toContain(
      'Forget this account everywhere',
    );
  });

  it('renames an account from an inline field', async () => {
    vi.mocked(api.updateAccount).mockResolvedValue(
      shared([{ ...WORK, label: 'office' }, PERSONAL]),
    );
    const r = await render();
    await pressMenuItem(r.root, 'account-claude-code-a-menu', 'account-claude-code-a-rename');
    await actAsync(() =>
      get(r, 'account-claude-code-a-rename-input').props.onChangeText(' office '),
    );
    await actAsync(async () => {
      get(r, 'account-claude-code-a-rename-submit').props.onPress();
      await flush();
    });
    expect(api.updateAccount).toHaveBeenCalledWith('claude-code', 'a', { label: 'office' });
  });

  it('reads Extra usage on one line: Turn on link when never taken out, organisation when policy blocks it', async () => {
    reportHost('h1', { hostName: 'hetzner' });
    const report = (disabledReason: string) =>
      usePresenceStore.getState().setHostAccount({
        type: 'host.account',
        hostId: 'h1',
        backendId: 'claude-code',
        connected: true,
        accountEmail: null,
        accounts: [
          {
            id: 'a',
            label: 'work',
            connected: true,
            accountEmail: null,
            usage: { at: 1_000, overage: { status: 'rejected', disabledReason } },
          },
        ],
      });
    report('org_level_disabled_until');
    const r = await render();
    const line = get(r, 'account-claude-code-a-usage-overage');
    expect(textOf(line)).toContain('Extra usage');
    expect(textOf(line)).toContain('Turn on ↗');
    expect(textOf(line)).not.toMatch(/overspent|not enabled/);
    expect(get(r, 'account-claude-code-a-usage-overage-manage').props.accessibilityRole).toBe(
      'link',
    );
    act(() => r.unmount());
    report('org_level_disabled');
    const r2 = await render();
    const line2 = textOf(get(r2, 'account-claude-code-a-usage-overage'));
    expect(line2).toContain('disabled by organisation');
    expect(line2).not.toContain('Turn on');
  });

  it('describes each account-picking strategy', async () => {
    const r = await render();
    expect(textOf(get(r, 'strategy-claude-code-hint'))).toBe(STRATEGY_HINT.priority);
    expect(Object.keys(STRATEGY_HINT)).toHaveLength(4);
    expect(get(r, 'strategy-claude-code-least-used').props.accessibilityHint).toBe(
      STRATEGY_HINT['least-used'],
    );
  });

  it('draws every provider in the registry the same way', async () => {
    const r = await render();
    for (const p of PROVIDERS) expect(query(r, `accounts-${p.id}`)).not.toBeNull();
  });

  it('signs in to ChatGPT through the server with no host online, and shows the code', async () => {
    vi.mocked(api.chatgptSignInStart).mockResolvedValue({
      signInId: 's1',
      userCode: 'ABCD-1234',
      url: 'https://auth.openai.com/codex/device',
      intervalSeconds: 60,
      expiresAt: Date.now() + 900_000,
    });
    const r = await render();
    expect(query(r, 'chatgpt-no-host')).toBeNull();
    expect(get(r, 'chatgpt-signin').props.disabled).toBeFalsy();
    await actAsync(() => get(r, 'chatgpt-signin').props.onPress());
    expect(api.chatgptSignInStart).toHaveBeenCalledWith({});
    expect(send).not.toHaveBeenCalled();
    expect(textOf(get(r, 'chatgpt-login-code'))).toBe('ABCD-1234');
    expect(query(r, 'chatgpt-login-cancel')).not.toBeNull();
  });

  it('offers Claude sign-in from the phone, beside pasting a token', async () => {
    const r = await render();
    expect(query(r, 'claude-signin-start')).not.toBeNull();
    expect(query(r, 'add-claude-account')).not.toBeNull();
  });

  it('no longer carries the limit setting: it is under Agent behaviour', async () => {
    const r = await render();
    expect(query(r, 'auto-resume-rate-limit')).toBeNull();
    expect(query(r, 'limit-behaviour-other_account')).toBeNull();
  });

  it('no longer carries the chat title and summary toggles', async () => {
    const r = await render();
    expect(query(r, 'title-generation')).toBeNull();
    expect(query(r, 'status-generation')).toBeNull();
  });
});

// Claude on Amazon Bedrock accounts and the Auto flag (spec/10 § Settings,
// § Choosing an account; design/bedrock-accounts).

const BEDROCK = {
  hostId: 'h1',
  awsProfile: 'work-bedrock',
  awsRegion: 'eu-west-2',
  regionPrefix: 'eu' as const,
  monthlyCapUsd: 100,
  spentUsd: 18.42,
  spentMonth: bedrockMonth(Date.now()),
};
const WORK_AWS = {
  id: 'w',
  label: 'Work Bedrock',
  connected: true,
  auto: false,
  state: { state: 'ready' as const },
  bedrock: BEDROCK,
};
const CLIENT_AWS = {
  id: 'x',
  label: 'Client X',
  connected: false,
  auto: false,
  state: { state: 'signed_out' as const },
  bedrock: { ...BEDROCK, hostId: 'h2', awsProfile: 'client-x', awsRegion: 'us-east-1' },
};

function seedClaude(claude: unknown[]): void {
  seedSettings({
    shared: {
      version: 1,
      secrets: { claude: claude as never, codex: [], providerKeys: [] },
      hosts: [],
    },
  });
}

describe('mobile Settings → Usage — Bedrock accounts and Auto', () => {
  it('draws a Bedrock row with its tag and labelled Host, AWS profile, Region, Monthly and Spent lines', async () => {
    reportHost('h1', { hostName: 'mac-mini', awsProfiles: [] });
    seedClaude([WORK, WORK_AWS]);
    const r = await render();
    expect(textOf(get(r, 'account-claude-code-w-tag'))).toBe('Bedrock');
    const lines = (id: string) => textOf(get(r, `account-claude-code-w-bedrock-${id}`));
    expect(lines('host')).toBe('Hostmac-mini');
    expect(lines('profile')).toBe('AWS profilework-bedrock');
    expect(lines('region')).toContain('eu-west-2');
    expect(lines('monthly')).toMatch(/Monthly18% · resets [A-Z][a-z]{2} 1$/);
    expect(lines('spent')).toBe('Spent$18.42 of $100 cap · estimated');
    // Never a subscription's usage bars or a probe's "not read yet".
    expect(query(r, 'account-claude-code-w-usage')).toBeNull();
  });

  it('a signed-out profile reads AWS sign-in expired in place of the spend lines', async () => {
    seedClaude([WORK, CLIENT_AWS]);
    const r = await render();
    expect(textOf(get(r, 'account-claude-code-x-bedrock-status'))).toBe(
      'StatusAWS sign-in expired',
    );
    expect(query(r, 'account-claude-code-x-bedrock-monthly')).toBeNull();
    expect(query(r, 'account-claude-code-x-bedrock-spent')).toBeNull();
  });

  it('a Bedrock row’s ⋯ offers Edit and Remove with no detail lines, and no sign-in', async () => {
    seedClaude([WORK, WORK_AWS]);
    const r = await render();
    await actAsync(() => get(r, 'account-claude-code-w-menu').props.onPress());
    expect(textOf(get(r, 'account-claude-code-w-edit'))).toBe('Edit');
    expect(textOf(get(r, 'account-claude-code-w-remove'))).toBe('Remove');
    expect(query(r, 'account-claude-code-w-connect')).toBeNull();
    expect(query(r, 'account-claude-code-w-rename')).toBeNull();
    // Out of the order: no rank to move.
    expect(query(r, 'account-claude-code-w-up')).toBeNull();
  });

  it('every Claude row starts with its Auto box; unticked rows sit last, unranked', async () => {
    seedClaude([WORK_AWS, WORK, PERSONAL]);
    const r = await render();
    expect(textOf(get(r, 'accounts-header-claude-code'))).toBe('AutoAccount');
    const order = r.root
      .findAll(
        (i) =>
          typeof i.type === 'string' && /^account-claude-code-[a-z]$/.test(i.props.testID ?? ''),
      )
      .map((i) => i.props.testID);
    expect(order).toEqual([
      'account-claude-code-a',
      'account-claude-code-b',
      'account-claude-code-w',
    ]);
    expect(get(r, 'account-claude-code-a-auto').props.accessibilityState.checked).toBe(true);
    expect(get(r, 'account-claude-code-w-auto').props.accessibilityState.checked).toBe(false);
    // ChatGPT accounts carry no Auto flag.
    expect(query(r, 'accounts-header-codex')).toBeNull();
  });

  it('ticking Auto writes it to the server', async () => {
    vi.mocked(api.updateAccount).mockResolvedValue(shared([WORK, { ...PERSONAL, auto: false }]));
    const r = await render();
    await actAsync(async () => {
      get(r, 'account-claude-code-b-auto').props.onPress();
      await flush();
    });
    expect(api.updateAccount).toHaveBeenCalledWith('claude-code', 'b', { auto: false });
  });

  it('moving a ranked account sends every account, the unranked ones last', async () => {
    vi.mocked(api.orderAccounts).mockResolvedValue(shared([PERSONAL, WORK]));
    seedClaude([WORK_AWS, WORK, PERSONAL]);
    const r = await render();
    await pressMenuItem(r.root, 'account-claude-code-a-menu', 'account-claude-code-a-down');
    await flush();
    expect(api.orderAccounts).toHaveBeenCalledWith('claude-code', ['b', 'a', 'w']);
  });

  it('adds a Bedrock account: host and profile pills, the profile’s region, auto off', async () => {
    reportHost('h1', {
      hostName: 'mac-mini',
      awsProfiles: [{ name: 'default' }, { name: 'work-bedrock', region: 'eu-west-2' }],
    });
    reportHost('h2', { hostName: 'old-host' }); // reports no awsProfiles: runs no Bedrock
    vi.mocked(api.addBedrockAccount).mockResolvedValue(shared([WORK, PERSONAL]));
    const r = await render();
    await actAsync(() => get(r, 'add-bedrock-account').props.onPress());
    expect(query(r, 'bedrock-form-host-h2')).toBeNull();
    // The one host that runs Bedrock is chosen already.
    expect(get(r, 'bedrock-form-host-h1').props.accessibilityState.selected).toBe(true);
    expect(get(r, 'bedrock-form-submit').props.disabled).toBe(true);
    await actAsync(() => get(r, 'bedrock-form-name').props.onChangeText('Work Bedrock'));
    await actAsync(() => get(r, 'bedrock-form-profile-work-bedrock').props.onPress());
    expect(get(r, 'bedrock-form-region').props.value).toBe('eu-west-2');
    expect(textOf(get(r, 'bedrock-form-prefix-auto'))).toBe('Auto (EU)');
    expect(textOf(get(r, 'bedrock-form-prefix-jp'))).toBe('Japan');
    expect(get(r, 'bedrock-form-auto').props.accessibilityState.checked).toBe(false);
    await actAsync(() => get(r, 'bedrock-form-cap').props.onChangeText('100'));
    await actAsync(async () => {
      get(r, 'bedrock-form-submit').props.onPress();
      await flush();
    });
    expect(api.addBedrockAccount).toHaveBeenCalledWith({
      label: 'Work Bedrock',
      hostId: 'h1',
      awsProfile: 'work-bedrock',
      awsRegion: 'eu-west-2',
      regionPrefix: 'auto',
      monthlyCapUsd: 100,
      auto: false,
    });
    expect(query(r, 'bedrock-form')).toBeNull();
  });

  it('says a refused Bedrock account in the server’s words and keeps the form', async () => {
    reportHost('h1', {
      hostName: 'mac-mini',
      awsProfiles: [{ name: 'work', region: 'eu-west-2' }],
    });
    vi.mocked(api.addBedrockAccount).mockRejectedValue(
      Object.assign(new Error('HTTP 409'), { body: { message: 'mac-mini is offline' } }),
    );
    const r = await render();
    await actAsync(() => get(r, 'add-bedrock-account').props.onPress());
    await actAsync(() => get(r, 'bedrock-form-name').props.onChangeText('Work'));
    await actAsync(() => get(r, 'bedrock-form-profile-work').props.onPress());
    await actAsync(() => get(r, 'bedrock-form-cap').props.onChangeText('$50'));
    await actAsync(async () => {
      get(r, 'bedrock-form-submit').props.onPress();
      await flush();
    });
    expect(__getLastAlert()?.message).toBe('mac-mini is offline');
    expect(query(r, 'bedrock-form')).not.toBeNull();
  });

  it('Edit opens the form filled in and sends only what changed', async () => {
    reportHost('h1', { hostName: 'mac-mini', awsProfiles: [{ name: 'work-bedrock' }] });
    seedClaude([WORK, WORK_AWS]);
    vi.mocked(api.updateAccount).mockResolvedValue(shared([WORK]));
    const r = await render();
    await pressMenuItem(r.root, 'account-claude-code-w-menu', 'account-claude-code-w-edit');
    const form = 'account-claude-code-w-form';
    expect(get(r, `${form}-name`).props.value).toBe('Work Bedrock');
    expect(get(r, `${form}-cap`).props.value).toBe('100');
    expect(get(r, `${form}-prefix-eu`).props.accessibilityState.selected).toBe(true);
    await actAsync(() => get(r, `${form}-cap`).props.onChangeText('250'));
    await actAsync(async () => {
      get(r, `${form}-submit`).props.onPress();
      await flush();
    });
    expect(api.updateAccount).toHaveBeenCalledWith('claude-code', 'w', { monthlyCapUsd: 250 });
  });
});
