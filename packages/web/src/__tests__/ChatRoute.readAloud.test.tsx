// Read aloud: assistant messages carry a read button; read-everything speaks new replies.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useReadAloud } from '../lib/readAloud.js';
import { setActiveWs } from '../api/ws.js';
import type { ChatEventEntry } from '../stores/chatStore.js';

vi.mock('../api/rest.js', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    getChatHistory: vi.fn().mockResolvedValue({ events: [] }),
  },
}));

const speak = vi.fn();

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
  useReadAloud.setState({ speaking: null, readAll: false });
  speak.mockReset();
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      constructor(public text: string) {}
    },
  );
  Object.defineProperty(window, 'speechSynthesis', {
    value: { speak, cancel: vi.fn() },
    configurable: true,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TURNS: ChatEventEntry[] = [
  { seq: 1, kind: 'message', role: 'user', content: 'ask', at: 0 },
  { seq: 2, kind: 'message', role: 'assistant', content: 'answer **bold**', at: 0 },
];

describe('read aloud', () => {
  it('shows a read button on assistant messages only, and speaks plain text', () => {
    seedChat(TURNS);
    renderChat();
    const buttons = screen.getAllByTestId('msg-read-trigger');
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(speak).toHaveBeenCalledTimes(1);
    expect((speak.mock.calls[0]![0] as { text: string }).text).toBe('answer bold');
    expect(screen.getByTestId('msg-read-trigger').getAttribute('data-state')).toBe('playing');
  });

  it('read everything speaks a new reply but not the history', () => {
    useReadAloud.setState({ readAll: true });
    seedChat(TURNS);
    renderChat();
    expect(speak).not.toHaveBeenCalled();
    act(() => {
      useChatStore.setState((s) => ({
        timelines: {
          ...s.timelines,
          c1: [
            ...TURNS,
            {
              seq: 3,
              kind: 'message',
              role: 'assistant',
              content: 'fresh',
              at: 0,
              messageAt: Date.now(),
            },
          ],
        },
      }));
    });
    expect(speak).toHaveBeenCalledTimes(1);
    expect((speak.mock.calls[0]![0] as { text: string }).text).toBe('fresh');
  });

  it('header toggle turns read everything on', () => {
    seedChat(TURNS);
    renderChat();
    fireEvent.click(screen.getByTestId('action-read-all'));
    expect(useReadAloud.getState().readAll).toBe(true);
  });
});
