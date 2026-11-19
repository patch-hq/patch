// spec/04 § Provider switches — a chat keeps one provider for its life.
// Picking another provider's model in the composer's model control drafts a
// new chat linked to this one and opens it on the new-chat screen; nothing is
// sent to the host. A same-provider pick is an ordinary model change, and the
// Manager changes provider in place.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render as rtlRender, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { WireEvent } from '@patch/wire';
import { ChatModelControl } from '../components/ChatModelControl.js';
import type { ChatRow } from '../stores/types.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePreferencesStore, DEFAULT_PREFERENCES } from '../stores/preferencesStore.js';
import { setActiveWs } from '../api/ws.js';
import { setModelCatalog, resetModelCatalog } from '../lib/models.js';

const continueChat = vi.fn();

vi.mock('../api/rest.js', () => ({
  api: {
    deleteChat: vi.fn(),
    pinChat: vi.fn(),
    renameChat: vi.fn(),
    archiveChat: vi.fn(),
    models: vi.fn(async () => ({ models: [], fetchedAt: '' })),
    continueChat: (...args: unknown[]) => continueChat(...args),
  },
  ApiError: class ApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
      readonly body: unknown,
    ) {
      super(message);
    }
  },
}));
vi.mock('../lib/voiceController.js', () => ({ startVoiceCall: vi.fn(async () => {}) }));

const sent: WireEvent[] = [];

function row(overrides: Partial<ChatRow> = {}): ChatRow {
  return {
    pendingWake: null,
    todos: [],
    snoozedUntil: null,
    chatId: 'c1',
    hostId: 'd1',
    permissionMode: 'bypassPermissions' as const,
    name: 'fix layout',
    folder: '~/projects/foo',
    activity: 'idle',
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
    statusSummary: null,
    statusKind: null,
    statusDeclared: null,
    pendingPermissions: [],
    lastSeq: 0,
    jobId: null,
    model: 'claude-sonnet-4-6',
    effort: null,
    rateLimitResumingAt: null,
    resumeKind: null,
    ...overrides,
  };
}

function Where(): ReactElement {
  const loc = useLocation();
  return <span data-testid="where">{loc.pathname + loc.search}</span>;
}

/** The control reads its chat from the store, as it does in the composer. */
function seed(r: ChatRow): void {
  useChatStore.setState((s) => ({ chats: { ...s.chats, [r.chatId]: r } }));
}

function render(r: ChatRow): ReturnType<typeof rtlRender> {
  seed(r);
  return rtlRender(
    <MemoryRouter initialEntries={['/chats/c1']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <ChatModelControl chatId={r.chatId} />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('model control — provider switch starts a linked chat', () => {
  beforeEach(() => {
    sent.length = 0;
    continueChat.mockReset();
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePreferencesStore.setState({ preferences: { ...DEFAULT_PREFERENCES }, loaded: true });
    resetModelCatalog();
    setModelCatalog({
      status: 'ready',
      models: [
        { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
        { id: 'claude-opus-4-1', label: 'Opus 4.1' },
        { id: 'openai/gpt-5-codex', label: 'GPT-5 Codex' },
      ],
    });
    setActiveWs({
      send: (e: WireEvent) => {
        sent.push(e);
      },
    } as never);
  });
  afterEach(() => {
    cleanup();
    setActiveWs(null);
    resetModelCatalog();
  });

  it('a cross-provider pick drafts a linked chat and opens it, sending nothing to the host', async () => {
    continueChat.mockResolvedValue({
      draft: {
        id: 'draft-linked-9',
        hostId: 'd1',
        folder: '~/projects/foo',
        model: 'openai/gpt-5-codex',
        text: 'This continues "fix layout"',
        continuedFrom: 'c1',
        updatedAt: 1,
      },
    });
    render(row({ model: 'claude-sonnet-4-6' }));
    fireEvent.click(screen.getByTestId('chat-model'));
    fireEvent.click(screen.getByTestId('model-option-openai/gpt-5-codex'));
    expect(continueChat).toHaveBeenCalledWith('c1', { model: 'openai/gpt-5-codex' });
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/chats/new?draft=draft-linked-9'),
    );
    expect(sent).toEqual([]);
  });

  it('says so when the linked chat cannot be drafted', async () => {
    continueChat.mockRejectedValue(new Error('server down'));
    render(row({ model: 'claude-sonnet-4-6' }));
    fireEvent.click(screen.getByTestId('chat-model'));
    fireEvent.click(screen.getByTestId('model-option-openai/gpt-5-codex'));
    await waitFor(() =>
      expect(
        useUiStore
          .getState()
          .errors.map((t) => t.message)
          .join(' '),
      ).toContain('Could not start a linked chat: server down'),
    );
    expect(screen.getByTestId('where').textContent).toBe('/chats/c1');
    expect(sent).toEqual([]);
  });

  it('a same-provider pick is an ordinary model change', () => {
    render(row({ model: 'claude-sonnet-4-6' }));
    fireEvent.click(screen.getByTestId('chat-model'));
    fireEvent.click(screen.getByTestId('model-option-claude-opus-4-1'));
    expect(continueChat).not.toHaveBeenCalled();
    expect(sent).toEqual([{ type: 'chat.model_request', chatId: 'c1', model: 'claude-opus-4-1' }]);
  });

  it('the Manager changes provider in place', () => {
    render(row({ chatId: 'thread_manager', model: 'claude-sonnet-4-6' }));
    fireEvent.click(screen.getByTestId('chat-model'));
    fireEvent.click(screen.getByTestId('model-option-openai/gpt-5-codex'));
    expect(continueChat).not.toHaveBeenCalled();
    expect(sent).toEqual([
      { type: 'chat.model_request', chatId: 'thread_manager', model: 'openai/gpt-5-codex' },
    ]);
  });

  it('offers every model in the catalogue, ChatGPT included', () => {
    setModelCatalog({
      status: 'ready',
      models: [
        ...Array.from({ length: 7 }, (_, n) => ({ id: `m${n}`, label: `Model ${n}` })),
        { id: 'openai/gpt-5-codex', label: 'GPT-5 Codex' },
      ],
    });
    render(row({ model: 'm0' }));
    fireEvent.click(screen.getByTestId('chat-model'));
    expect(screen.getAllByRole('option')).toHaveLength(8);
    expect(screen.getByTestId('model-option-openai/gpt-5-codex')).toBeInTheDocument();
  });
});
