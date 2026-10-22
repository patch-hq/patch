// When a chat's provider is spent but the other one on the host has credit, the
// out-of-usage banner offers to move the chat across (spec/04 § Model).

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { HostAccountSummary, WireEvent } from '@patch/wire';
import { OutOfUsageBanner } from '../components/OutOfUsageBanner.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { setActiveWs } from '../api/ws.js';
import { setModelCatalog, resetModelCatalog } from '../lib/models.js';
import { clearHosts, reportAccounts } from './presenceHelpers.js';

vi.mock('../api/rest.js', () => ({
  api: { models: vi.fn(async () => ({ models: [], fetchedAt: '' })) },
}));

const NOW = Date.UTC(2026, 9, 12, 10, 0, 0);
const spent = (id: string): HostAccountSummary => ({
  id,
  label: id,
  accountEmail: null,
  connected: true,
  usage: { session: { status: 'rejected', utilization: 1, resetsAt: NOW + 3_600_000 } },
});
const fine = (id: string): HostAccountSummary => ({
  id,
  label: id,
  accountEmail: null,
  connected: true,
  usage: { session: { status: 'allowed', utilization: 0.1 } },
});
const reportCodex = (accounts: HostAccountSummary[]): void =>
  usePresenceStore.getState().setHostAccount({
    type: 'host.account',
    hostId: 'h',
    backendId: 'codex',
    connected: accounts.some((a) => a.connected),
    accountEmail: null,
    accounts,
  });

const sent: WireEvent[] = [];
const renderBanner = (model = 'claude-opus-5'): void => {
  render(
    <MemoryRouter>
      <OutOfUsageBanner hostId="h" model={model} chatId="c1" />
    </MemoryRouter>,
  );
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  sent.length = 0;
  setActiveWs({ send: (e: WireEvent) => void sent.push(e) } as never);
  resetModelCatalog();
  setModelCatalog({
    status: 'ready',
    models: [
      { id: 'claude-opus-5', label: 'Opus 5' },
      { id: 'openai/gpt-5', label: 'GPT-5' },
    ],
  });
  usePreferencesStore.setState({
    preferences: {
      ...usePreferencesStore.getState().preferences,
      suppressProviderSwitchWarning: false,
    },
  });
});
afterEach(() => {
  cleanup();
  clearHosts();
  setActiveWs(null);
  vi.useRealTimers();
});

describe('OutOfUsageBanner — offering the other provider', () => {
  it('offers ChatGPT when Claude is spent and ChatGPT has credit, and switches after confirming', () => {
    reportAccounts('h', [spent('a')]);
    reportCodex([fine('x')]);
    renderBanner();
    const btn = screen.getByTestId('out-of-usage-switch');
    expect(btn.textContent).toBe('Switch to ChatGPT');
    fireEvent.click(btn);
    expect(sent).toEqual([]); // the cross-provider warning comes first
    fireEvent.click(screen.getByRole('button', { name: /^switch$/i }));
    expect(sent).toEqual([
      { type: 'chat.model_request', chatId: 'c1', model: 'openai/gpt-5', retry: true },
    ]);
  });

  it('switches at once when the warning is turned off', () => {
    usePreferencesStore.setState({
      preferences: {
        ...usePreferencesStore.getState().preferences,
        suppressProviderSwitchWarning: true,
      },
    });
    reportAccounts('h', [spent('a')]);
    reportCodex([fine('x')]);
    renderBanner();
    fireEvent.click(screen.getByTestId('out-of-usage-switch'));
    expect(sent).toHaveLength(1);
  });

  it('offers Claude when a ChatGPT chat is spent and Claude has credit', () => {
    reportAccounts('h', [fine('a')]);
    reportCodex([spent('x')]);
    renderBanner('openai/gpt-5');
    expect(screen.getByTestId('out-of-usage-switch').textContent).toBe('Switch to Claude');
    fireEvent.click(screen.getByTestId('out-of-usage-switch'));
    fireEvent.click(screen.getByRole('button', { name: /^switch$/i }));
    expect(sent).toEqual([
      { type: 'chat.model_request', chatId: 'c1', model: 'claude-opus-5', retry: true },
    ]);
  });

  it('offers nothing when the other provider is spent too', () => {
    reportAccounts('h', [spent('a')]);
    reportCodex([spent('x')]);
    renderBanner();
    expect(screen.getByTestId('out-of-usage-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('out-of-usage-switch')).toBeNull();
  });

  it('offers nothing when the other provider is not connected or has not reported', () => {
    reportAccounts('h', [spent('a')]);
    renderBanner();
    expect(screen.queryByTestId('out-of-usage-switch')).toBeNull();
    cleanup();
    reportCodex([{ id: 'x', label: 'x', accountEmail: null, connected: false }]);
    renderBanner();
    expect(screen.queryByTestId('out-of-usage-switch')).toBeNull();
  });

  it('offers nothing when the catalogue has no model for the other provider', () => {
    setModelCatalog({ status: 'ready', models: [{ id: 'claude-opus-5', label: 'Opus 5' }] });
    reportAccounts('h', [spent('a')]);
    reportCodex([fine('x')]);
    renderBanner();
    expect(screen.queryByTestId('out-of-usage-switch')).toBeNull();
  });
});
