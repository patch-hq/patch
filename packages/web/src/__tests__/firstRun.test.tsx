// The first minutes of a new user's app, with nothing connected (design/setup-wizard):
// what the model list says, what a page-only group is called, and the Connect
// page every "Sign in" goes to.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, renderHook } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useModelOptions } from '../routes/settings/modelOptions.js';
import { ConnectRoute } from '../routes/ConnectRoute.js';
import { pageGroupTitle } from '../components/PaneArea.js';
import { resetModelCatalog, setModelCatalog } from '../lib/models.js';
import type { Group } from '../stores/layoutStore.js';
import {
  clearHosts,
  clearSharedAccounts,
  reportHost,
  setSharedAccounts,
} from './presenceHelpers.js';

beforeEach(() => {
  clearHosts();
  clearSharedAccounts();
  resetModelCatalog();
});
afterEach(() => {
  clearSharedAccounts();
  resetModelCatalog();
});

describe('the model list with no AI connected', () => {
  it('says models arrive with a sign-in, not the host’s refusal code', () => {
    setSharedAccounts({});
    reportHost('h1');
    setModelCatalog({ models: [], status: 'error', error: 'upstream' });
    const { result } = renderHook(() => useModelOptions('claude-opus-5'));
    expect(result.current.problem).toEqual({
      kind: 'no-provider',
      text: 'Models appear once you connect an AI.',
    });
    // The default is kept as an option.
    expect(result.current.options.map((o) => o.id)).toEqual(['claude-opus-5']);
  });

  it('with an AI connected, a failure is said in words and the code kept for Details', () => {
    setSharedAccounts({ claude: [{ connected: true }] });
    reportHost('h1');
    const { result } = renderHook(() => useModelOptions('claude-opus-5'));
    act(() => setModelCatalog({ models: [], status: 'error', error: 'upstream' }));
    expect(result.current.problem).toEqual({
      kind: 'error',
      text: 'Couldn’t load the model list for that host. Try again in a moment.',
      detail: 'upstream',
    });
  });

  it('a failure with no code still reads as English', () => {
    setSharedAccounts({ claude: [{ connected: true }] });
    reportHost('h1');
    const { result } = renderHook(() => useModelOptions('claude-opus-5'));
    act(() => setModelCatalog({ models: [], status: 'error' }));
    expect(result.current.problem).toMatchObject({ kind: 'error', detail: 'unknown error' });
  });
});

describe('a group showing a page, not a chat', () => {
  const group = (tabs: Group['root'] extends infer R ? R : never): Group =>
    ({ id: 'g1', chatId: null, root: tabs, activePaneId: 'p1', layouts: {}, size: 1 }) as Group;

  it('is named after the page in front', () => {
    expect(
      pageGroupTitle(
        group({
          type: 'leaf',
          id: 'p1',
          tabs: [{ id: 'page:settings', descriptor: { kind: 'page', page: 'settings' } }],
          activeTabId: 'page:settings',
        }),
      ),
    ).toBe('Settings');
  });

  it('only a group with nothing in it is empty', () => {
    expect(pageGroupTitle(group({ type: 'leaf', id: 'p1', tabs: [], activeTabId: null }))).toBe(
      'Empty group',
    );
  });
});

describe('the Connect page', () => {
  function renderConnect(): void {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new', '/connect']} initialIndex={1}>
          <Routes>
            <Route path="/connect" element={<ConnectRoute />} />
            <Route path="/chats/new" element={<div data-testid="back-in-chat" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('leads with signing in to Claude, says which plans work, and Not now goes back', () => {
    setSharedAccounts({});
    renderConnect();
    expect(screen.getByRole('heading', { name: 'Connect an AI' })).toBeInTheDocument();
    expect(screen.getByTestId('welcome-claude-plans')).toHaveTextContent(
      'Works with a Claude Pro, Max, Team or Enterprise plan.',
    );
    expect(screen.getByTestId('claude-signin-start')).toBeInTheDocument();
    const close = screen.getByTestId('connect-close');
    expect(close).toHaveTextContent('Not now');
    fireEvent.click(close);
    expect(screen.getByTestId('back-in-chat')).toBeInTheDocument();
  });

  it('once connected, the account shows and the way out reads Done', () => {
    setSharedAccounts({ claude: [{ connected: true }] });
    renderConnect();
    expect(screen.getByTestId('welcome-claude-connected')).toHaveTextContent('Claude 0');
    expect(screen.queryByTestId('claude-signin-start')).toBeNull();
    expect(screen.getByTestId('connect-close')).toHaveTextContent('Done');
  });
});
