// A tool call that has not returned shows it is running (spinner + elapsed
// time), and the sidebar badge stays `working` until the call returns, even if
// the host's `activity` has gone idle.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { deriveBadge } from '../stores/types.js';
import { act } from '@testing-library/react';
import { deliveryTracker } from '../lib/deliveryTracker.js';
import { setActiveWs } from '../api/ws.js';

vi.mock('../api/rest.js', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    getFileContent: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    getFileContentAtHead: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    skills: vi.fn(async () => ({ skills: [] })),
    setGoal: vi.fn(async () => undefined),
    setReminder: vi.fn(async () => undefined),
  },
}));

const NOW = 1_800_000_000_000;

function seed(): void {
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      hostId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'deploy',
      folder: 'foo',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
      goal: null,
      reminder: null,
      pendingWake: null,
      todos: [],
    },
  ]);
}

function renderChat(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/chats/c1']}>
      <Routes>
        <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('running tool call', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    deliveryTracker.reset();
    setActiveWs(null);
  });

  const call = {
    type: 'chat.tool_call' as const,
    chatId: 'c1',
    seq: 1,
    tool: 'Bash',
    args: { command: 'grep -r token ~', description: 'Search home' },
    callId: 'call-1',
    startedAt: NOW,
  };

  // Reported 7 Oct 2026: the clock started when the chat was viewed, not when
  // the call started. It runs from the wire's `startedAt`.
  it('times a call from when it started, not from when the chat was opened', () => {
    seed();
    useChatStore.getState().applyEvent({ ...call, startedAt: NOW - 90_000 });
    renderChat();
    expect(screen.getByTestId('tool-running-elapsed').textContent).toBe('1m 30s');
  });

  // A long run of short calls: each call's clock restarts, the turn's does not.
  it('shows how long the whole turn has been working beside the call clock', () => {
    seed();
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 0,
      role: 'user',
      content: 'go',
      createdAt: NOW - 25 * 60_000,
    } as never);
    useChatStore.getState().applyEvent({ ...call, startedAt: NOW - 5_000 });
    renderChat();
    expect(screen.getByTestId('tool-running-elapsed').textContent).toBe('5s');
    expect(screen.getByTestId('tool-running-turn').textContent).toBe('working for 25m 00s');
  });

  it('shows the spinner but no clock when the start time is unknown', () => {
    seed();
    const noStart = { ...call };
    delete (noStart as Partial<typeof call>).startedAt;
    useChatStore.getState().applyEvent(noStart);
    renderChat();
    expect(screen.getByTestId('tool-running')).toBeTruthy();
    expect(screen.queryByTestId('tool-running-elapsed')).toBeNull();
  });

  it.each(['AskUserQuestion', 'mcp__patch__patch_ask_human'])(
    'shows no timer on a %s question',
    (tool) => {
      seed();
      useChatStore.getState().applyEvent({ ...call, tool, args: { questions: [] } });
      renderChat();
      expect(screen.queryByTestId('tool-running')).toBeNull();
    },
  );

  // Reported 7 Oct 2026: a Bash call waiting for Approve/Deny showed a running
  // timer although nothing was running. The call has not started until it is
  // approved, and the card must show the command being approved.
  it('shows no timer while the call waits for approval, and the approval card names the command', () => {
    seed();
    useChatStore.getState().applyEvent(call);
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r1',
      request: { tool: 'Bash', args: call.args, description: 'Search home' },
      seq: 2,
    });
    renderChat();
    expect(screen.queryByTestId('tool-running')).toBeNull();
    expect(screen.getByTestId('permission-command').textContent).toBe('grep -r token ~');
  });

  it('starts the timer once the approval is resolved', () => {
    seed();
    useChatStore.getState().applyEvent(call);
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r1',
      request: { tool: 'Bash', args: call.args },
      seq: 2,
    });
    useChatStore.getState().resolvePermission('c1', 'r1', 'approve');
    renderChat();
    expect(screen.getByTestId('tool-running')).toBeTruthy();
  });

  it('shows a spinner and elapsed time on an unreturned call, and working in the sidebar', () => {
    seed();
    useChatStore.getState().applyEvent(call);
    expect(deriveBadge(useChatStore.getState().chats['c1']!)).toBe('working');
    renderChat();
    expect(screen.getByTestId('tool-running')).toBeTruthy();
    expect(screen.getByTestId('tool-running-elapsed').textContent).toBe('0s');
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByTestId('tool-running-elapsed').textContent).toBe('5s');
  });

  it('drops the running state and the working badge once the result lands', () => {
    seed();
    useChatStore.getState().applyEvent(call);
    useChatStore.getState().applyEvent({
      type: 'chat.tool_result',
      chatId: 'c1',
      seq: 2,
      tool: 'Bash',
      result: 'ok',
      callId: 'call-1',
    });
    expect(deriveBadge(useChatStore.getState().chats['c1']!)).not.toBe('working');
    renderChat();
    expect(screen.queryByTestId('tool-running')).toBeNull();
  });

  it('clears the open call when the turn is stopped', () => {
    seed();
    useChatStore.getState().applyEvent(call);
    useChatStore.getState().applyEvent({ type: 'chat.stopped', chatId: 'c1' } as never);
    expect(deriveBadge(useChatStore.getState().chats['c1']!)).not.toBe('working');
  });

  // Reported 6 Oct 2026: cancelling a command while another message was
  // already queued behind it PROMOTES that queued turn instead of settling
  // the chat idle, so `activity` is still `running` when `chat.stopped`
  // lands (spec/09 § A turn the user stopped). The cancelled call's own row
  // must still drop its spinner — it must not keep reading as running (or
  // stuck) for as long as the turn that replaced it happens to run.
  it('stops the cancelled call from reading as running when the stop promotes a queued turn', () => {
    seed();
    useChatStore.getState().applyEvent(call);
    // The turn is still running (a promote never dips through idle) when
    // `chat.stopped` lands — see spec/09 § A turn the user stopped.
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'running',
      lastUpdated: 1,
    });
    useChatStore.getState().applyEvent({ type: 'chat.stopped', chatId: 'c1' } as never);
    expect(useChatStore.getState().chats['c1']!.activity).toBe('running');
    renderChat();
    expect(screen.queryByTestId('tool-running')).toBeNull();
  });
  // A cancelled call has no result in the log, so reopening the chat replays it
  // as an unreturned call. The user message that followed proves it is over.
  it('does not read a replayed cancelled call as running once a later user message follows', () => {
    seed();
    useChatStore.getState().applyEvent(call);
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 2,
      role: 'user',
      content: 'try something else',
    } as never);
    renderChat();
    expect(screen.queryByTestId('tool-running')).toBeNull();
  });

  it('shows the running spinner on a collapsed group holding an unreturned call', () => {
    seed();
    useChatStore.getState().applyEvent({ ...call, callId: 'call-0', seq: 1 });
    useChatStore.getState().applyEvent({
      type: 'chat.tool_result',
      chatId: 'c1',
      seq: 2,
      tool: 'Bash',
      result: 'ok',
      callId: 'call-0',
    });
    useChatStore.getState().applyEvent({ ...call, callId: 'call-1', seq: 3 });
    renderChat();
    const group = screen.getByTestId('tool-group');
    expect(group.getAttribute('data-open')).toBe('false');
    expect(screen.getByTestId('tool-running')).toBeTruthy();
  });

  // 12 Nov 2026: a growing run showed only a vague AI label ("Investigating…")
  // that lagged several calls behind, so a working chat looked stuck.
  it('shows the newest call beside the label of a live collapsed run, not once it is final', () => {
    seed();
    const store = useChatStore.getState();
    store.applyEvent(call);
    store.applyEvent({
      ...call,
      seq: 2,
      callId: 'call-2',
      args: { command: 'ls', description: 'List the repo' },
    });
    store.applyEvent({
      type: 'chat.tool_run_summary',
      chatId: 'c1',
      callIds: ['call-1'],
      summary: 'Investigating…',
      live: true,
      seq: 3,
    });
    renderChat();
    expect(screen.getByTestId('tool-group-latest').textContent).toBe('List the repo');
    act(() => {
      store.applyEvent({
        type: 'chat.tool_result',
        chatId: 'c1',
        callId: 'call-1',
        result: 'ok',
        seq: 4,
      } as never);
      store.applyEvent({
        type: 'chat.tool_result',
        chatId: 'c1',
        callId: 'call-2',
        result: 'ok',
        seq: 5,
      } as never);
      store.applyEvent({
        type: 'chat.tool_run_summary',
        chatId: 'c1',
        callIds: ['call-1', 'call-2'],
        summary: 'Looked around',
        seq: 6,
      });
    });
    expect(screen.queryByTestId('tool-group-latest')).toBeNull();
  });
});

describe('cancel one running command', () => {
  const sent: unknown[] = [];
  beforeEach(() => {
    sent.length = 0;
    useChatStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs({ send: (e: unknown) => sent.push(e) } as never);
  });
  afterEach(() => {
    cleanup();
    setActiveWs(null);
  });
  const call = {
    type: 'chat.tool_call' as const,
    chatId: 'c1',
    seq: 1,
    tool: 'Bash',
    args: { command: 'sleep 100' },
    callId: 'call-cancel',
    startedAt: Date.now(),
  };

  it('sends chat.tool_cancel_request for just that call, then shows the chip once it returns as an error', () => {
    seed();
    useChatStore.getState().applyEvent(call);
    renderChat();
    fireEvent.click(screen.getByTestId('tool-cancel'));
    expect(sent.filter((e) => (e as { type: string }).type === 'chat.tool_cancel_request')).toEqual(
      [{ type: 'chat.tool_cancel_request', chatId: 'c1', callId: 'call-cancel' }],
    );
    expect(screen.queryByTestId('tool-cancelled')).toBeNull();
    act(() => {
      useChatStore.getState().applyEvent({
        type: 'chat.tool_result',
        chatId: 'c1',
        tool: 'Bash',
        callId: 'call-cancel',
        result: 'Exit code 130',
        isError: true,
        seq: 2,
      });
    });
    expect(screen.getByTestId('tool-cancelled').textContent).toBe('Cancelled by you');
    expect(screen.queryByTestId('tool-cancel')).toBeNull();
  });

  it('offers no cancel on a non-Bash call', () => {
    seed();
    useChatStore.getState().applyEvent({ ...call, tool: 'Read', args: { file_path: '/x' } });
    renderChat();
    expect(screen.queryByTestId('tool-cancel')).toBeNull();
  });
});
