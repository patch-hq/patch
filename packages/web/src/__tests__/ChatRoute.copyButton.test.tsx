// spec/14 § Messages — every user and assistant message carries a copy button
// that puts its markdown source on the clipboard.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
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
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TURNS: ChatEventEntry[] = [
  { seq: 1, kind: 'message', role: 'user', content: 'ask **one**', at: 0 },
  { seq: 2, kind: 'message', role: 'assistant', content: 'answer\n\n- a\n- b', at: 0 },
];

describe('message copy button', () => {
  it('is on every user and assistant message', () => {
    seedChat(TURNS);
    renderChat();
    expect(screen.getAllByTestId('msg-copy-trigger')).toHaveLength(2);
  });

  it('copies the markdown source and shows a tick', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    seedChat(TURNS);
    renderChat();
    fireEvent.click(screen.getAllByTestId('msg-copy-trigger')[1]!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('answer\n\n- a\n- b'));
    await waitFor(() =>
      expect(screen.getAllByTestId('msg-copy-trigger')[1]!.getAttribute('data-state')).toBe(
        'copied',
      ),
    );
  });

  it('says so when the clipboard write fails', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    seedChat(TURNS);
    renderChat();
    fireEvent.click(screen.getAllByTestId('msg-copy-trigger')[0]!);
    await waitFor(() =>
      expect(screen.getAllByTestId('msg-copy-trigger')[0]!.getAttribute('data-state')).toBe(
        'failed',
      ),
    );
  });
});
