// Queued turns that all hit the same failure (e.g. a session limit) each raise
// their own error row. The same failure straight after itself draws once.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { setActiveWs } from '../api/ws.js';
import type { ChatEventEntry } from '../stores/chatStore.js';

vi.mock('../api/rest.js', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    checkHooks: vi.fn(async () => ({ decision: 'pass', results: [] })),
  },
}));

const err = (seq: number, content: string): ChatEventEntry => ({
  seq,
  kind: 'error',
  errorCode: 'sdk_error',
  content,
  at: 0,
});

function renderWith(timeline: ChatEventEntry[]) {
  useChatStore.getState().hydrate([
    {
      chatId: 'c-e',
      hostId: 'd1',
      permissionMode: 'auto' as const,
      name: 'c-e',
      folder: 'foo',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    },
  ]);
  useChatStore.setState((s) => ({ timelines: { ...s.timelines, 'c-e': timeline } }));
  const ws = { send: vi.fn(), requestReplay() {} } as unknown as Parameters<
    typeof ChatRoute
  >[0]['ws'];
  render(
    <MemoryRouter initialEntries={['/chats/c-e']}>
      <Routes>
        <Route path="/chats/:chatId" element={<ChatRoute ws={ws} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('repeated turn errors', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
  });
  afterEach(() => cleanup());

  it('draws three identical consecutive errors once', () => {
    renderWith([err(1, 'limit hit'), err(2, 'limit hit'), err(3, 'limit hit')]);
    expect(screen.getAllByTestId('turn-error')).toHaveLength(1);
  });

  it('still draws a different error', () => {
    renderWith([err(1, 'limit hit'), err(2, 'other'), err(3, 'limit hit')]);
    expect(screen.getAllByTestId('turn-error')).toHaveLength(3);
  });
});
