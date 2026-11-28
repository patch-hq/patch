// "Send answer and snooze" is a snooze like any other: the open chat leaves the
// list, so you move on to the next chat (spec/04 § Snooze, same path as the sheet).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { ChatRoute } from '../routes/ChatRoute.js';
import { api } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { setActiveWs } from '../api/ws.js';
import { resetArchiveNav } from '../lib/archiveNav.js';

vi.mock('../api/rest.js', () => ({
  api: {
    getChatArtifacts: vi.fn(async () => ({ artifacts: [] })),
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    checkHooks: vi.fn(async () => ({ decision: 'pass', results: [] })),
    snoozeChat: vi.fn(async () => undefined),
    clearSnoozeBack: vi.fn(async () => undefined),
  },
}));

const base = {
  hostId: 'd1',
  permissionMode: 'auto' as const,
  folder: 'foo',
  status: 'active' as const,
  pinned: false,
  pinnedAt: null,
  disabled: false,
};

function Where(): JSX.Element {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

describe('Send answer and snooze', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    resetArchiveNav();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
  });
  afterEach(() => {
    cleanup();
    setActiveWs(null);
  });

  it('moves on to the next chat', async () => {
    useChatStore.getState().hydrate([
      {
        ...base,
        chatId: 'c1',
        name: 'one',
        activity: 'awaiting-permission',
        lastUpdated: 2,
        snoozedUntil: null,
        snoozeRecords: [
          {
            setId: 's',
            startedAt: 1000,
            startSeq: 0,
            until: 61_000,
            endedAt: 2000,
            outcome: { kind: 'waiting' },
            backCleared: false,
          },
        ],
      } as never,
      { ...base, chatId: 'c2', name: 'two', activity: 'idle', lastUpdated: 1 } as never,
    ]);
    useChatStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        c1: [
          {
            seq: 1,
            kind: 'permission',
            tool: 'AskUserQuestion',
            requestId: 'r1',
            toolArgs: {
              questions: [
                {
                  header: 'H',
                  question: 'Which?',
                  multiSelect: false,
                  options: [
                    { label: 'A', description: 'a' },
                    { label: 'B', description: 'b' },
                  ],
                },
              ],
            },
            at: 0,
          },
        ],
      },
    }));
    useChatStore.getState().setActiveChat('c1');
    const ws = { send: vi.fn(), requestReplay() {}, requestHistory() {} } as never;
    render(
      <MemoryRouter initialEntries={['/chats/c1']}>
        <Where />
        <Routes>
          <Route path="/chats/:chatId" element={<ChatRoute ws={ws} />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(
      screen.getAllByTestId('question-option').find((b) => b.getAttribute('data-label') === 'A')!,
    );
    fireEvent.click(screen.getByTestId('question-submit-snooze'));
    await waitFor(() => expect(api.snoozeChat).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/chats/c2'));
  });
});
