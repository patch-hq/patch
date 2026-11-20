// Manual sort: project headers drag into a saved order (spec/14 § Sidebar ordering).

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

const folders = (): string[] =>
  screen.getAllByTestId(/^folder-head-/).map((el) => el.getAttribute('title')!);

describe('Sidebar — manual project order', () => {
  beforeEach(() => {
    localStorage.clear();
    useChatStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    useVoiceStore.setState({ activeDevices: {} });
    useUiStore.setState({
      chatSort: 'manual',
      groupSort: 'same-as-chats',
      manualOrder: [],
      folderOrder: [],
      forgottenFolders: [],
    });
    vi.spyOn(api, 'listChatsArchived').mockResolvedValue({ chats: [], nextCursor: null });
    vi.spyOn(api, 'listChatsDeleted').mockResolvedValue({ chats: [], nextCursor: null });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('dragging a project header onto another reorders and persists the projects', () => {
    useChatStore
      .getState()
      .hydrate([
        rowFixture({ chatId: 'a', name: 'a', folder: '~/alpha', lastUserActivity: 300 }),
        rowFixture({ chatId: 'b', name: 'b', folder: '~/beta', lastUserActivity: 200 }),
        rowFixture({ chatId: 'c', name: 'c', folder: '~/gamma', lastUserActivity: 100 }),
      ]);
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    expect(folders()).toEqual(['~/alpha', '~/beta', '~/gamma']);
    const heads = screen.getAllByTestId(/^folder-head-/);
    const data = new Map<string, string>();
    const dataTransfer = {
      types: ['application/x-patch-folder'],
      effectAllowed: '',
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? '',
    };
    fireEvent.dragStart(heads[2]!, { dataTransfer });
    fireEvent.dragOver(heads[0]!, { dataTransfer });
    fireEvent.drop(heads[0]!, { dataTransfer });
    expect(folders()).toEqual(['~/gamma', '~/alpha', '~/beta']);
    expect(JSON.parse(localStorage.getItem('patch.sidebar.folderOrder')!)).toHaveLength(3);
  });

  it('project headers are not draggable when projects are not manually sorted', () => {
    useUiStore.setState({ chatSort: 'recent' });
    useChatStore.getState().hydrate([rowFixture({ chatId: 'a', name: 'a', folder: '~/alpha' })]);
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    expect(screen.getByTestId(/^folder-head-/).getAttribute('draggable')).toBeNull();
  });
});
