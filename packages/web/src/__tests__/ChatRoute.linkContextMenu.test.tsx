// spec/14 § Message context menu — right-clicking a link inside a message leaves
// the platform's own link menu (Copy Link Address) alone; the message menu,
// whose Copy takes the whole message, only opens off a link.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { setActiveWs } from '../api/ws.js';
import type { ChatEventEntry } from '../stores/chatStore.js';

vi.mock('../api/rest.js', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    getChatHistory: vi.fn().mockResolvedValue({ events: [] }),
  },
}));

function seedChat(timeline: ChatEventEntry[]): void {
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      hostId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'c1',
      folder: 'foo',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    },
  ]);
  useChatStore.setState((s) => ({ timelines: { ...s.timelines, c1: timeline } }));
}

function renderChat() {
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

beforeEach(() => {
  useChatStore.getState()._reset();
  useUiStore.getState().clearToasts();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setHostOnline('d1', true);
  setActiveWs(null);
});
afterEach(cleanup);

const TURNS: ChatEventEntry[] = [
  { seq: 1, kind: 'message', role: 'user', content: 'hi', at: 0 },
  {
    seq: 2,
    kind: 'message',
    role: 'assistant',
    content: 'see [docs](https://example.com/x)',
    at: 0,
  },
];

describe('message context menu on a link', () => {
  it('opens the message menu off a link (control)', () => {
    seedChat(TURNS);
    renderChat();
    fireEvent.contextMenu(screen.getAllByTestId('msg')[1]!);
    expect(screen.getByTestId('msg-context-menu')).toBeInTheDocument();
  });

  it('does not open the message menu, nor cancel the native one, on a link', () => {
    seedChat(TURNS);
    renderChat();
    const link = screen.getByRole('link', { name: 'docs' });
    const notCancelled = fireEvent.contextMenu(link);
    expect(screen.queryByTestId('msg-context-menu')).not.toBeInTheDocument();
    expect(notCancelled).toBe(true);
  });
});
