// When a chat's provider is spent but the other one on the host has credit, the
// out-of-usage banner offers a provider switch: a new chat linked to this one,
// drafted by the server with the unanswered request in its first message
// (spec/04 § Provider switches).

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { HostAccountSummary, WireEvent } from '@patch/wire';
import { OutOfUsageBanner } from '../components/OutOfUsageBanner.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';
import { setActiveWs } from '../api/ws.js';
import { setModelCatalog, resetModelCatalog } from '../lib/models.js';
import { clearHosts, reportAccounts } from './presenceHelpers.js';

const continueChat = vi.fn();
vi.mock('../api/rest.js', () => ({
  api: {
    models: vi.fn(async () => ({ models: [], fetchedAt: '' })),
    continueChat: (...args: unknown[]) => continueChat(...args),
  },
  ApiError: class ApiError extends Error {},
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

const mk = (id: string): never =>
  ({ id, label: id, connected: true, accountEmail: null, kind: 'chatgpt' }) as never;
const setShared = (claude: string[], codex: string[]): void =>
  usePreferencesStore.setState({
    shared: { secrets: { claude: claude.map(mk), codex: codex.map(mk) } } as never,
  });

const sent: WireEvent[] = [];
function Where(): ReactElement {
  const loc = useLocation();
  return <span data-testid="where">{loc.pathname + loc.search}</span>;
}
const renderBanner = (model = 'claude-opus-5'): void => {
  render(
    <MemoryRouter initialEntries={['/chats/c1']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <OutOfUsageBanner hostId="h" model={model} chatId="c1" />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  sent.length = 0;
  continueChat.mockReset();
  continueChat.mockResolvedValue({
    draft: {
      id: 'draft-linked-2',
      hostId: 'h',
      folder: '/w',
      model: 'openai/gpt-5',
      text: 'Still unanswered',
      continuedFrom: 'c1',
      updatedAt: 1,
    },
  });
  setActiveWs({ send: (e: WireEvent) => void sent.push(e) } as never);
  resetModelCatalog();
  setModelCatalog({
    status: 'ready',
    models: [
      { id: 'claude-opus-5', label: 'Opus 5' },
      { id: 'openai/gpt-5', label: 'GPT-5' },
    ],
  });
  usePreferencesStore.setState({ shared: null });
});
afterEach(() => {
  cleanup();
  clearHosts();
  setActiveWs(null);
  vi.useRealTimers();
});

describe('OutOfUsageBanner — Change provider', () => {
  it('lists Codex when Claude is spent and Codex has credit, and opens a linked chat on it', async () => {
    setShared(['a'], ['x']);
    reportAccounts('h', [spent('a')]);
    reportCodex([fine('x')]);
    renderBanner();
    fireEvent.click(screen.getByTestId('rate-limit-change-provider'));
    const options = within(screen.getByTestId('rate-limit-provider-menu')).getAllByRole('menuitem');
    expect(options.map((o) => o.textContent)).toEqual(['Codex']);
    fireEvent.click(options[0]!);
    expect(continueChat).toHaveBeenCalledWith('c1', { model: 'openai/gpt-5' });
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/chats/new?draft=draft-linked-2'),
    );
    // Nothing is sent to the host: the spent chat stays as it is.
    expect(sent).toEqual([]);
  });

  it('lists Claude when a Codex chat is spent and Claude has credit', () => {
    setShared(['a'], ['x']);
    reportAccounts('h', [fine('a')]);
    reportCodex([spent('x')]);
    renderBanner('openai/gpt-5');
    fireEvent.click(screen.getByTestId('rate-limit-change-provider'));
    expect(screen.getByTestId('rate-limit-provider-option').textContent).toBe('Claude');
    fireEvent.click(screen.getByTestId('rate-limit-provider-option'));
    expect(continueChat).toHaveBeenCalledWith('c1', { model: 'claude-opus-5' });
    expect(sent).toEqual([]);
  });

  it('is disabled with a reason when no other provider has usage left', () => {
    setShared(['a'], ['x']);
    reportAccounts('h', [spent('a')]);
    reportCodex([spent('x')]);
    renderBanner();
    const btn = screen.getByTestId('rate-limit-change-provider');
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAttribute('title', 'No other provider has usage left');
  });

  it('is disabled when the other provider is not connected', () => {
    setShared(['a'], []);
    reportAccounts('h', [spent('a')]);
    renderBanner();
    expect(screen.getByTestId('rate-limit-change-provider')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});
