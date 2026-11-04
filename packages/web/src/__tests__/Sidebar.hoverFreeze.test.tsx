// Nothing reorders while the pointer is over the chat list; the order catches
// up when it leaves (spec/14 § Sidebar ordering).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '../components/Sidebar.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api } from '../api/rest.js';
import type { ChatRow } from '../stores/types.js';

function rowFixture(overrides: Partial<ChatRow>): ChatRow {
  return {
    hostId: 'd1',
    permissionMode: 'bypassPermissions' as const,
    folder: '~/proj',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 1,
    ...overrides,
  } as ChatRow;
}

const order = (): string[] =>
  screen
    .getAllByTestId(/^chat-row-/)
    .map((el) => el.getAttribute('data-testid')!.replace('chat-row-', ''));

describe('Sidebar — hover freezes the order', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    useVoiceStore.setState({ activeDevices: {} });
    useUiStore.setState({ chatSort: 'recent', groupSort: 'same-as-chats', forgottenFolders: [] });
    vi.spyOn(api, 'listChatsArchived').mockResolvedValue({ chats: [], nextOffset: null });
    vi.spyOn(api, 'listChatsDeleted').mockResolvedValue({ chats: [], nextOffset: null });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('holds positions while hovered and applies the new order on leave', () => {
    useChatStore
      .getState()
      .hydrate([
        rowFixture({ chatId: 'a', name: 'a', lastUserActivity: 200 }),
        rowFixture({ chatId: 'b', name: 'b', lastUserActivity: 100 }),
      ]);
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    expect(order()).toEqual(['a', 'b']);
    const list = screen.getByTestId('sb-scroll');
    fireEvent.mouseEnter(list);
    act(() => {
      useChatStore
        .getState()
        .hydrate([
          rowFixture({ chatId: 'a', name: 'a', lastUserActivity: 200 }),
          rowFixture({ chatId: 'b', name: 'b', lastUserActivity: 900 }),
        ]);
    });
    expect(order()).toEqual(['a', 'b']);
    fireEvent.mouseLeave(list);
    expect(order()).toEqual(['b', 'a']);
  });
});
