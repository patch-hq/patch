// A new install's sidebar says what to do, rather than showing nothing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '../components/Sidebar.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api } from '../api/rest.js';
import { clearSharedAccounts, setSharedAccounts } from './presenceHelpers.js';

function renderSidebar(): void {
  render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>,
  );
}

describe('Sidebar with no chats', () => {
  beforeEach(() => {
    localStorage.clear();
    useChatStore.getState()._reset();
    useChatStore.setState({ hydrated: true });
    usePresenceStore.getState().setConnection('connected');
    useUiStore.getState().setAttentionOnly(false);
    vi.spyOn(api, 'listChatsArchived').mockResolvedValue({ chats: [], nextCursor: null });
    vi.spyOn(api, 'listChatsDeleted').mockResolvedValue({ chats: [], nextCursor: null });
  });
  afterEach(() => {
    cleanup();
    clearSharedAccounts();
    vi.restoreAllMocks();
  });

  it('with no AI connected, points to connecting one', () => {
    setSharedAccounts({ claude: [{ connected: false }], codex: [{ connected: false }] });
    renderSidebar();
    const hint = screen.getByTestId('sidebar-empty');
    expect(hint.textContent).toMatch(/No chats yet/);
    expect(hint.querySelector('a')?.getAttribute('href')).toBe('/connect');
  });

  it('with an AI connected, points to New chat', () => {
    setSharedAccounts({ claude: [{ connected: true }] });
    renderSidebar();
    const hint = screen.getByTestId('sidebar-empty');
    expect(hint.textContent).toMatch(/New chat/);
    expect(hint.querySelector('a')).toBeNull();
  });
});
