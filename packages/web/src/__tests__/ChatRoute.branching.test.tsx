// spec/04 § Branching + spec/14 § Main chat panel ("Edit / fork a turn, and
// switch tracks") — a chat is a graph: editing a user turn forks a new track
// from it, and a fork point offers a track switcher.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { useComposerDraftStore } from '../stores/composerDraftStore.js';
import { api } from '../api/rest.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useSideThreadsStore, DRAFT_TAB_ID } from '../stores/sideThreadsStore.js';
import { setActiveWs } from '../api/ws.js';
import type { ChatEventEntry } from '../stores/chatStore.js';

vi.mock('../api/rest.js', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    getChatHistory: vi.fn().mockResolvedValue({ events: [] }),
    uploadAttachment: vi.fn(),
  },
}));

function seedChat(chatId: string, timeline: ChatEventEntry[]): void {
  useChatStore.getState().hydrate([
    {
      chatId,
      hostId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: chatId,
      folder: 'foo',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    },
  ]);
  useChatStore.setState((s) => ({ timelines: { ...s.timelines, [chatId]: timeline } }));
}

function renderChat(chatId: string, ws: Parameters<typeof ChatRoute>[0]['ws'] = null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/chats/${chatId}`]}>
        <Routes>
          <Route path="/chats/:chatId" element={<ChatRoute ws={ws} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const TWO_TRACKS = {
  type: 'chat.branches' as const,
  chatId: 'c-fork',
  activeBranchId: 'b1',
  branches: [
    { branchId: 'b0', parentBranchId: null, forkFromSeq: null, label: 'main', createdAt: 0 },
    { branchId: 'b1', parentBranchId: 'b0', forkFromSeq: 4, label: 'edit 1', createdAt: 1 },
  ],
};

beforeEach(() => {
  useChatStore.getState()._reset();
  useUiStore.getState().clearToasts();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setHostOnline('d1', true);
  setActiveWs(null);
});
afterEach(() => cleanup());

describe('editing a user turn forks a track', () => {
  it('offers an edit affordance on a settled USER turn only', () => {
    seedChat('c-fork', [
      { seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 },
      { seq: 5, kind: 'message', role: 'assistant', content: 'answer one', at: 0 },
      // Still in flight (carries a localId) — it is not in the transcript yet,
      // so there is nothing to fork from.
      { seq: 6, kind: 'message', role: 'user', content: 'in flight', localId: 'L9', at: 0 },
    ]);
    renderChat('c-fork');
    expect(screen.getAllByTestId('msg-edit')).toHaveLength(1);
  });

  const WS = () =>
    ({ send: vi.fn(), requestReplay() {} }) as unknown as Parameters<typeof ChatRoute>[0]['ws'];

  it('the pencil carries the turn into the MAIN composer, keeping every control', () => {
    seedChat('c-fork', [
      { seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 },
      { seq: 5, kind: 'message', role: 'assistant', content: 'answer one', at: 0 },
    ]);
    renderChat('c-fork', WS());
    fireEvent.click(screen.getByTestId('msg-edit'));

    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe('ask one');
    expect(screen.getByTestId('composer-edit-banner')).toBeTruthy();
    // No second, cut-down editor inside the turn.
    expect(screen.queryByTestId('msg-editor')).toBeNull();
    // Attachments (and the rest of the composer) stay available.
    expect(screen.getByTestId('attach-btn')).toBeTruthy();
    expect(screen.getByTestId('send-btn').getAttribute('title')).toContain('Save edit');
  });

  it('marks the edited turn as the anchor the greying runs from', () => {
    seedChat('c-fork', [
      { seq: 2, kind: 'message', role: 'user', content: 'earlier', at: 0 },
      { seq: 3, kind: 'message', role: 'assistant', content: 'earlier answer', at: 0 },
      { seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 },
      { seq: 5, kind: 'message', role: 'assistant', content: 'answer one', at: 0 },
    ]);
    renderChat('c-fork', WS());
    fireEvent.click(screen.getAllByTestId('msg-edit')[1]!);
    const anchors = document.querySelectorAll('.msg-edit-anchor');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.getAttribute('data-seq')).toBe('4');
  });

  it('sending from the composer fires chat.fork_request with that turn seq and the new text', async () => {
    const ws = WS();
    seedChat('c-fork', [
      { seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 },
      { seq: 5, kind: 'message', role: 'assistant', content: 'answer one', at: 0 },
    ]);
    renderChat('c-fork', ws);

    fireEvent.click(screen.getByTestId('msg-edit'));
    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: 'ask one, rephrased' },
    });
    fireEvent.click(screen.getByTestId('send-btn'));

    await waitFor(() =>
      expect(ws!.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'chat.fork_request',
          chatId: 'c-fork',
          seq: 4,
          message: 'ask one, rephrased',
        }),
      ),
    );
    // The old track's transcript is dropped — the host's replay of the new
    // track is the authority, so no stale turns linger from the track we left.
    expect(useChatStore.getState().timelines['c-fork']).toEqual([]);
    expect(screen.queryByTestId('composer-edit-banner')).toBeNull();
  });

  it('files attached while editing are uploaded and ride the fork', async () => {
    const ws = WS();
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL() {} }),
    );
    vi.mocked(api.uploadAttachment).mockResolvedValue({
      ok: true,
      ref: { id: 'a1', name: 'pic.png', mimeType: 'image/png', kind: 'image', url: '/x/a1' },
    });
    seedChat('c-fork', [{ seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 }]);
    renderChat('c-fork', ws);

    fireEvent.click(screen.getByTestId('msg-edit'));
    fireEvent.change(screen.getByTestId('composer-file-input'), {
      target: { files: [new File(['x'], 'pic.png', { type: 'image/png' })] },
    });
    fireEvent.click(screen.getByTestId('send-btn'));

    await waitFor(() =>
      expect(ws!.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'chat.fork_request',
          seq: 4,
          attachments: [{ id: 'a1', name: 'pic.png', mimeType: 'image/png', kind: 'image' }],
        }),
      ),
    );
  });

  it('cancelling sends nothing, restores the unsent draft and clears the grey-out', () => {
    const ws = WS();
    seedChat('c-fork', [{ seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 }]);
    useComposerDraftStore.getState().setDraft('c-fork', 'half-typed');
    renderChat('c-fork', ws);

    fireEvent.click(screen.getByTestId('msg-edit'));
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'changed' } });
    fireEvent.click(screen.getByTestId('composer-edit-cancel'));

    expect(ws!.send).not.toHaveBeenCalled();
    expect(screen.queryByTestId('composer-edit-banner')).toBeNull();
    expect(document.querySelector('.msg-edit-anchor')).toBeNull();
    expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe('half-typed');
    expect(screen.getByTestId('msg-content').textContent).toContain('ask one');
  });

  it('Esc in the composer cancels the edit', () => {
    const ws = WS();
    seedChat('c-fork', [{ seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 }]);
    renderChat('c-fork', ws);
    fireEvent.click(screen.getByTestId('msg-edit'));
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Escape' });
    expect(screen.queryByTestId('composer-edit-banner')).toBeNull();
    expect(ws!.send).not.toHaveBeenCalled();
  });

  // The side-thread feature was removed (Todoist) and is now being rebuilt in
  // three steps (spec/04 § Side threads, spec/14 § Side threads panel) — this
  // step wires up the trigger on every settled message, user or assistant.
  it('offers no side-thread affordance on a turn still in flight (no fork point yet)', () => {
    seedChat('c-fork', [
      { seq: 6, kind: 'message', role: 'user', content: 'in flight', localId: 'L9', at: 0 },
    ]);
    renderChat('c-fork');
    expect(screen.queryByTestId('msg-side-thread-trigger')).toBeNull();
  });
});

describe('spec/14 § Side threads panel — trigger', () => {
  beforeEach(() => {
    useSideThreadsStore.setState({
      panelChatId: null,
      activeTabByChatId: {},
      closedTabsByChatId: {},
      tabOrderByChatId: {},
      pendingNewTab: {},
      draftByChatId: {},
    });
  });

  it('hovering reveals a side-thread button on a SETTLED message of either role', () => {
    seedChat('c-fork', [
      { seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 },
      { seq: 5, kind: 'message', role: 'assistant', content: 'answer one', at: 0 },
    ]);
    renderChat('c-fork');
    expect(screen.getAllByTestId('msg-side-thread-trigger')).toHaveLength(2);
  });

  it('clicking it opens the panel on a draft, "Off <quoted message>", cursor in its composer', () => {
    seedChat('c-fork', [{ seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 }]);
    renderChat('c-fork');
    fireEvent.click(screen.getByTestId('msg-side-thread-trigger'));

    const state = useSideThreadsStore.getState();
    expect(state.panelChatId).toBe('c-fork');
    expect(state.activeTabByChatId['c-fork']).toBe(DRAFT_TAB_ID);
    expect(state.draftByChatId['c-fork']).toEqual({ seq: 4, quotedMessage: 'ask one' });
  });

  it('right-click offers "Open side thread" in the message context menu', () => {
    seedChat('c-fork', [{ seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 }]);
    renderChat('c-fork');
    fireEvent.contextMenu(screen.getByTestId('msg'));
    const item = screen.getByText('Open side thread');
    fireEvent.click(item);

    expect(useSideThreadsStore.getState().draftByChatId['c-fork']).toEqual({
      seq: 4,
      quotedMessage: 'ask one',
    });
  });

  it('a message with a side thread carries a marker; clicking it opens the panel on that tab', async () => {
    seedChat('c-fork', [{ seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 }]);
    useChatStore.getState().applyEvent({
      type: 'chat.branches',
      chatId: 'c-fork',
      activeBranchId: 'b0',
      branches: [
        { branchId: 'b0', parentBranchId: null, forkFromSeq: null, label: 'main', createdAt: 0 },
        {
          branchId: 'b1',
          parentBranchId: 'b0',
          forkFromSeq: 4,
          label: 'side 1',
          createdAt: 1,
          sideThread: true,
          name: 'Annual vs monthly',
        },
      ],
    });
    renderChat('c-fork');
    const marker = await screen.findByTestId('side-thread-marker-b1');
    expect(marker.textContent).toContain('Side thread');

    fireEvent.click(marker);
    const state = useSideThreadsStore.getState();
    expect(state.panelChatId).toBe('c-fork');
    expect(state.activeTabByChatId['c-fork']).toBe('b1');
  });

  it('a side thread is never offered as a track to SWITCH to — only the marker', () => {
    seedChat('c-fork', [{ seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 }]);
    useChatStore.getState().applyEvent({
      type: 'chat.branches',
      chatId: 'c-fork',
      activeBranchId: 'b0',
      branches: [
        { branchId: 'b0', parentBranchId: null, forkFromSeq: null, label: 'main', createdAt: 0 },
        {
          branchId: 'b1',
          parentBranchId: 'b0',
          forkFromSeq: 4,
          label: 'side 1',
          createdAt: 1,
          sideThread: true,
        },
      ],
    });
    renderChat('c-fork');
    expect(screen.queryByTestId('track-switcher')).toBeNull();
  });
});

describe('switching between tracks at a fork point', () => {
  it('renders a track switcher on the forked turn showing which track is active', () => {
    seedChat('c-fork', [{ seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 }]);
    useChatStore.getState().applyEvent(TWO_TRACKS);
    renderChat('c-fork');
    expect(screen.getByTestId('track-switcher').textContent).toContain('2/2');
  });

  it('the ‹ arrow switches to the previous track', () => {
    const send = vi.fn();
    const requestReplay = vi.fn();
    seedChat('c-fork', [{ seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 }]);
    useChatStore.getState().applyEvent(TWO_TRACKS);
    renderChat('c-fork', { send, requestReplay } as unknown as Parameters<
      typeof ChatRoute
    >[0]['ws']);

    fireEvent.click(screen.getByTestId('track-prev'));
    expect(send).toHaveBeenCalledWith({
      type: 'chat.branch_switch_request',
      chatId: 'c-fork',
      branchId: 'b0',
    });
    expect(useChatStore.getState().timelines['c-fork']).toEqual([]);
    // The cleared timeline always recomputes fromSeq -1 — forcing past the
    // dedup cursor is the only way the new track's history actually arrives
    // (see api/ws.ts's requestReplay: without `force` this collides with the
    // cursor cached by the chat's very first load and is silently dropped).
    expect(requestReplay).toHaveBeenCalledWith('c-fork', { force: true });
  });

  it('a chat with a single root track shows no switcher at all', () => {
    seedChat('c-fork', [{ seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 }]);
    useChatStore.getState().applyEvent({
      type: 'chat.branches',
      chatId: 'c-fork',
      activeBranchId: 'b0',
      branches: [
        { branchId: 'b0', parentBranchId: null, forkFromSeq: null, label: 'main', createdAt: 0 },
      ],
    });
    renderChat('c-fork');
    expect(screen.queryByTestId('track-switcher')).toBeNull();
  });
});

describe('Retry on the message hover button and context menu', () => {
  const wsWith = (send: ReturnType<typeof vi.fn>) =>
    ({ send, requestReplay() {} }) as unknown as Parameters<typeof ChatRoute>[0]['ws'];

  it('hover button on a settled user turn resends its text as a new turn', () => {
    const send = vi.fn();
    seedChat('c-fork', [{ seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 }]);
    renderChat('c-fork', wsWith(send));
    fireEvent.click(screen.getByTestId('msg-retry-trigger'));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.input', chatId: 'c-fork', message: 'ask one' }),
    );
  });

  it('right-click menu offers Retry on a user turn and it resends', () => {
    const send = vi.fn();
    seedChat('c-fork', [{ seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 }]);
    renderChat('c-fork', wsWith(send));
    fireEvent.contextMenu(screen.getByTestId('msg'));
    fireEvent.click(screen.getByText('Retry'));
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.input', message: 'ask one' }),
    );
  });

  it('Retry on an assistant reply re-runs the user message it answered', () => {
    const send = vi.fn();
    seedChat('c-fork', [
      { seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 },
      { seq: 5, kind: 'message', role: 'assistant', content: 'answer one', at: 0 },
    ]);
    renderChat('c-fork', wsWith(send));
    fireEvent.click(screen.getAllByTestId('msg-retry-trigger')[1]!);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.input', chatId: 'c-fork', message: 'ask one' }),
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('Retry takes the old reply off screen and shows the switcher at once, before the host answers', () => {
    const send = vi.fn();
    seedChat('c-fork', [
      { seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 },
      { seq: 5, kind: 'message', role: 'assistant', content: 'answer one', at: 0 },
    ]);
    renderChat('c-fork', wsWith(send));
    expect(screen.queryByTestId('attempt-switcher')).toBeNull();
    fireEvent.click(screen.getAllByTestId('msg-retry-trigger')[1]!);
    expect(screen.queryByText('answer one')).toBeNull();
    expect(screen.getByTestId('attempt-count').textContent).toBe('2/2');
  });

  it('then only the new reply shows, and ‹ walks back to the old one', () => {
    const send = vi.fn();
    seedChat('c-fork', [
      { seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 },
      { seq: 5, kind: 'message', role: 'assistant', content: 'answer one', at: 0 },
    ]);
    renderChat('c-fork', wsWith(send));
    fireEvent.click(screen.getAllByTestId('msg-retry-trigger')[1]!);
    act(() => {
      const s = useChatStore.getState();
      s.applyEvent({
        type: 'chat.message',
        chatId: 'c-fork',
        role: 'user',
        content: 'ask one',
        seq: 6,
        retryOfSeq: 4,
      });
      s.applyEvent({
        type: 'chat.message',
        chatId: 'c-fork',
        role: 'assistant',
        content: 'answer two',
        seq: 7,
      });
    });
    expect(screen.queryByText('answer one')).toBeNull();
    expect(screen.getByText('answer two')).toBeTruthy();
    expect(screen.getByTestId('attempt-count').textContent).toBe('2/2');
    fireEvent.click(screen.getByTestId('attempt-prev'));
    expect(screen.getByText('answer one')).toBeTruthy();
    expect(screen.queryByText('answer two')).toBeNull();
  });

  it('assistant right-click menu offers Retry', () => {
    const send = vi.fn();
    seedChat('c-fork', [
      { seq: 4, kind: 'message', role: 'user', content: 'ask one', at: 0 },
      { seq: 5, kind: 'message', role: 'assistant', content: 'answer one', at: 0 },
    ]);
    renderChat('c-fork', wsWith(send));
    fireEvent.contextMenu(screen.getAllByTestId('msg')[1]!);
    fireEvent.click(screen.getByText('Retry'));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ message: 'ask one' }));
  });
});
