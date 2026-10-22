// spec/14 ## Main chat panel — Action requests: patch_ask_human is a card
// with live links and a copyable code, not a collapsed tool row.
// (originally: spec/09 § `### push`, spec/14 ## Main chat panel — a patch_notify call
// carrying deepLink renders that link as a tappable row on the collapsed
// tool-call summary itself, not buried in the expanded JSON.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
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

describe('ChatRoute — patch_ask_human card', () => {
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

  function ask(args: Record<string, unknown>): void {
    seed();
    useChatStore.getState().applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 1,
      tool: 'mcp__patch__patch_ask_human',
      args,
      callId: 'call-1',
    });
  }

  it('shows the task with a clickable link and a copyable code, outside any tool group', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    ask({
      task: 'Open https://device.example.com/activate and enter ABCD-EFGH',
      why: 'until then the login is blocked',
    });
    renderChat();
    expect(screen.getByTestId('ask-human-task').textContent).toContain('and enter ABCD-EFGH');
    expect(screen.getByTestId('ask-human-why').textContent).toContain('blocked');
    const link = screen.getByTestId('ask-human-link');
    expect(link.getAttribute('href')).toBe('https://device.example.com/activate');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(screen.queryByTestId('tool-group')).toBeNull();
    const code = screen.getByTestId('ask-human-code');
    fireEvent.click(code);
    expect(writeText).toHaveBeenCalledWith('ABCD-EFGH');
    await vi.waitFor(() => expect(code.getAttribute('data-copied')).toBe('true'));
  });

  it('leaves a request with unreadable args as the ordinary row', () => {
    ask({ nope: true });
    renderChat();
    expect(screen.queryByTestId('ask-human-card')).toBeNull();
  });
});
