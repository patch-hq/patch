// The ⋯ menu's "Loop or wake…" arms a new loop (every N) or a one-shot wake
// through the same `api.setLoop` the composer's /loop uses.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ChatHeader } from '../components/ChatHeader.js';
import type { ChatRow } from '../stores/types.js';
import { useChatStore } from '../stores/chatStore.js';
import { api } from '../api/rest.js';

vi.mock('../api/rest.js', () => ({
  api: { setLoop: vi.fn(async () => undefined) },
}));
vi.mock('../lib/voiceController.js', () => ({ startVoiceCall: vi.fn(async () => {}) }));

function row(): ChatRow {
  return {
    chatId: 'c1',
    hostId: 'd1',
    permissionMode: 'bypassPermissions' as const,
    name: 'watcher',
    folder: '~/projects/foo',
    chatStatus: { state: 'idle', since: 0 },
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
    lastUserActivity: 0,
    awaitingPermission: false,
    lastReadSeq: -1,
    preview: null,
    goal: null,
    goalProgress: null,
    lastGoal: null,
    reminder: null,
    pendingWake: null,
    todos: [],
    statusSummary: null,
    statusKind: null,
    statusDeclared: null,
    pendingPermissions: [],
    lastSeq: 0,
    jobId: null,
    model: null,
    effort: null,
    rateLimitResumingAt: null,
    resumeKind: null,
    snoozedUntil: null,
  };
}

function open(): void {
  const r = row();
  useChatStore.setState({ chats: { c1: r } });
  render(
    <MemoryRouter initialEntries={['/chats/c1']}>
      <Routes>
        <Route path="*" element={<ChatHeader row={r} />} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByTestId('action-more'));
  fireEvent.click(screen.getByTestId('action-set-wake'));
}

describe('ChatHeader — loop or wake', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    vi.mocked(api.setLoop).mockClear();
  });
  afterEach(cleanup);

  it('arms a loop', async () => {
    open();
    fireEvent.change(screen.getByTestId('wake-edit-message'), { target: { value: 'check build' } });
    fireEvent.change(screen.getByTestId('wake-edit-every'), { target: { value: '5m' } });
    fireEvent.click(screen.getByTestId('wake-edit-save'));
    await waitFor(() =>
      expect(api.setLoop).toHaveBeenCalledWith('c1', { message: 'check build', every: '5m' }),
    );
  });

  it('arms a one-shot wake', async () => {
    open();
    fireEvent.click(screen.getByTestId('wake-edit-kind-at'));
    fireEvent.change(screen.getByTestId('wake-edit-message'), { target: { value: 'nudge' } });
    fireEvent.click(screen.getByTestId('wake-edit-save'));
    await waitFor(() => expect(api.setLoop).toHaveBeenCalled());
    const [, body] = vi.mocked(api.setLoop).mock.calls[0]!;
    expect(body).toMatchObject({ message: 'nudge' });
    expect(body).toHaveProperty('at');
  });

  it('will not save without a message', () => {
    open();
    expect(screen.getByTestId('wake-edit-save')).toBeDisabled();
  });
});
