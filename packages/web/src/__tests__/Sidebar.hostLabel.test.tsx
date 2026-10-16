// Sidebar rows name their host when the title is shared across hosts (spec/04 § Name).
//
// The sidebar's view dropdown sits at the top of the sidebar; picking Batch
// swaps the chat list for the batch panel. Membership is server-driven
// (spec/14 § Batch mode — auto-membership), so there is no per-row control
// here any more; `BatchPanel.test.tsx` covers the panel's own behaviour.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '../components/Sidebar.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useBatchStore } from '../stores/batchStore.js';
import { api } from '../api/rest.js';
import { reportHost } from './presenceHelpers.js';
import type { ChatRow } from '../stores/types.js';

function seedChat(chatId: string, name: string, hostId = 'd1'): void {
  const row: ChatRow = {
    pendingWake: null,
    todos: [],
    snoozedUntil: null,
    chatId,
    hostId,
    permissionMode: 'bypassPermissions' as const,
    name,
    folder: '~/proj',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
    lastUserActivity: 0,
    awaitingPermission: false,
    lastReadSeq: 5,
    preview: null,
    goal: null,
    goalProgress: null,
    lastGoal: null,
    reminder: null,
    statusSummary: null,
    statusKind: null,
    statusDeclared: null,
    pendingPermissions: [],
    lastSeq: 9, // done — unseen activity
    jobId: null,
    model: null,
    rateLimitResumingAt: null,
    resumeKind: null,
  };
  useChatStore.setState((s) => ({ chats: { ...s.chats, [chatId]: row } }));
}

describe('Sidebar host label on ambiguous titles', () => {
  beforeEach(() => {
    localStorage.clear();
    useChatStore.getState()._reset();
    useBatchStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    useVoiceStore.setState({ activeDevices: {} });
    useUiStore.getState().setAttentionOnly(false);
    reportHost('d1', { hostName: 'Hetzner' });
    reportHost('d2', { hostName: 'Mac' });
    vi.spyOn(api, 'listChatsArchived').mockResolvedValue({ chats: [], nextOffset: null });
    vi.spyOn(api, 'listChatsDeleted').mockResolvedValue({ chats: [], nextOffset: null });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows each host on chats whose title appears on two hosts', () => {
    seedChat('c1', 'Fix login', 'd1');
    seedChat('c2', 'Fix login', 'd2');
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('row-host-c1').textContent).toBe('Hetzner');
    expect(screen.getByTestId('row-host-c2').textContent).toBe('Mac');
  });

  it('shows no host on a uniquely titled chat or a same-host duplicate', () => {
    seedChat('c1', 'Fix login', 'd1');
    seedChat('c2', 'Fix login', 'd1');
    seedChat('c3', 'Other', 'd2');
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('row-host-c1')).toBeNull();
    expect(screen.queryByTestId('row-host-c2')).toBeNull();
    expect(screen.queryByTestId('row-host-c3')).toBeNull();
  });
});
