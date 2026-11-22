// spec/04 § Resume — a chat whose provider session is gone stays readable, says
// plainly that the model's memory of it ends there, and offers Start a linked
// chat (the provider-switch flow, on the same model).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { JSX } from 'react';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { deliveryTracker } from '../lib/deliveryTracker.js';
import { setActiveWs } from '../api/ws.js';
import { api } from '../api/rest.js';

vi.mock('../api/rest.js', () => ({
  api: {
    getChatArtifacts: vi.fn(async () => ({ artifacts: [] })),
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    getFileContent: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    getFileContentAtHead: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    skills: vi.fn(async () => ({ skills: [] })),
    models: vi.fn(async () => ({ models: [], fetchedAt: '' })),
    continueChat: vi.fn(async () => ({
      draft: {
        id: 'draft-linked-g',
        hostId: 'd1',
        folder: '/tmp/foo',
        text: 'This continues "test chat"',
        continuedFrom: 'c1',
        updatedAt: 1,
      },
    })),
  },
  ApiError: class ApiError extends Error {},
}));
vi.mock('../lib/voiceController.js', () => ({ startVoiceCall: vi.fn(async () => {}) }));

const GONE =
  "The model's memory of this chat ends here: its session is no longer on this host. The next message starts a new session.";

function seed(extra: Record<string, unknown> = {}): void {
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      hostId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'test chat',
      folder: '/tmp/foo',
      chatStatus: { state: 'idle', since: 0 },
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
      goal: null,
      reminder: null,
      ...extra,
    },
  ]);
  act(() => {
    useChatStore.getState().applyEvents([
      { type: 'chat.message', chatId: 'c1', role: 'user', content: 'earlier ask', seq: 1 },
      { type: 'chat.message', chatId: 'c1', role: 'assistant', content: 'earlier reply', seq: 2 },
      {
        type: 'chat.message',
        chatId: 'c1',
        role: 'system',
        content: GONE,
        sessionGone: true,
        seq: 3,
      },
    ]);
  });
}

function Where(): JSX.Element {
  const loc = useLocation();
  return <span data-testid="where">{loc.pathname + loc.search}</span>;
}

function renderChat(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/chats/c1']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <Routes>
                <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
              </Routes>
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ChatRoute — a provider session that is gone', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
    vi.mocked(api.continueChat).mockClear();
  });
  afterEach(() => {
    cleanup();
    deliveryTracker.reset();
  });

  it('keeps the record readable and says plainly where the memory ends', () => {
    seed();
    renderChat();
    expect(screen.getByText('earlier reply')).toBeTruthy();
    expect(screen.getByTestId('session-gone').textContent).toContain(GONE);
  });

  it('Start a linked chat drafts one on the same model and opens it', async () => {
    seed();
    renderChat();
    fireEvent.click(screen.getByTestId('session-gone-linked-chat'));
    expect(api.continueChat).toHaveBeenCalledWith('c1', {});
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/chats/new?draft=draft-linked-g'),
    );
  });

  it('a chat already continued offers no second linked chat', () => {
    seed({ continuedIn: 'c2' });
    renderChat();
    expect(screen.getByTestId('session-gone')).toBeTruthy();
    expect(screen.queryByTestId('session-gone-linked-chat')).toBeNull();
  });
});
