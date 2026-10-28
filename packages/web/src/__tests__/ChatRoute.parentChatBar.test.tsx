// A chat another chat launched with patch_spawn carries a bar at the top
// linking back to that chat; an ordinary chat carries none. Sibling of the job bar.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { setActiveWs } from '../api/ws.js';

vi.mock('../api/rest.js', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    getFileContent: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    getFileContentAtHead: vi.fn(async () => ({ path: '', content: '', size: 0 })),
  },
}));

const base = {
  hostId: 'd1',
  permissionMode: 'bypassPermissions' as const,
  folder: 'foo',
  activity: 'idle' as const,
  status: 'active' as const,
  pinned: false,
  pinnedAt: null,
  disabled: false,
  lastUpdated: 0,
  jobId: null,
};

function seed(parentChatId?: string, withParent = true): void {
  useChatStore.getState().hydrate([
    ...(withParent ? [{ ...base, chatId: 'p1', name: 'planner' }] : []),
    {
      ...base,
      chatId: 'c1',
      name: 'child',
      ...(parentChatId !== undefined ? { parentChatId } : {}),
    },
  ]);
}

function renderChat(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/chats/c1']}>
        <Routes>
          <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ChatRoute — parent chat bar', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
  });
  afterEach(() => {
    cleanup();
    setActiveWs(null);
  });

  it('names the chat that launched this one and links to it', () => {
    seed('p1');
    renderChat();
    expect(screen.getByTestId('parent-chat-bar')).toHaveTextContent('Started by "planner" chat');
    expect(screen.getByTestId('parent-chat-bar-link')).toBeInTheDocument();
  });

  it('still shows the bar when the launching chat is not known to this surface', () => {
    seed('gone', false);
    renderChat();
    expect(screen.getByTestId('parent-chat-bar')).toHaveTextContent('Started by another chat');
  });

  it('shows no bar on an ordinary chat', () => {
    seed();
    renderChat();
    expect(screen.queryByTestId('parent-chat-bar')).not.toBeInTheDocument();
  });

  it('hides the bar when dismissed', () => {
    seed('p1');
    renderChat();
    fireEvent.click(screen.getByTestId('parent-chat-bar-dismiss'));
    expect(screen.queryByTestId('parent-chat-bar')).not.toBeInTheDocument();
  });

  it('takes the parent from the chat.spawned frame', () => {
    useChatStore.getState()._reset();
    useChatStore.getState().applyEvent({
      type: 'chat.spawned',
      chatId: 'c1',
      hostId: 'd1',
      folder: 'foo',
      parentChatId: 'p1',
    });
    expect(useChatStore.getState().chats['c1']?.parentChatId).toBe('p1');
  });
});
