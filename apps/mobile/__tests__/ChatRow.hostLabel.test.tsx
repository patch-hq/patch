// A Chats-tab row names its host when its title is shared with a chat on
// another host (spec/04 § Name); otherwise it carries no host.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderRN, findHost, queryHost, byTestId, textOf } from './testUtils/render';
import { reportHost } from './testUtils/settingsFixtures';
import { ChatRowItem } from '../src/components/ChatRow';
import type { ChatRow as ChatRowT } from '../src/stores/types';
import { useChatStore } from '../src/stores/chatStore';
import { __resetRouterMock } from './stubs/expo-router';

vi.mock('../src/components/ChatLongPressSheet', () => ({
  showChatLongPressSheet: vi.fn(),
  showChatSnoozeSheet: vi.fn(),
  showHiddenChat: vi.fn(),
  toggleArchive: vi.fn(),
  togglePin: vi.fn(),
  applySnooze: vi.fn(),
}));

function makeRow(chatId: string, hostId: string, name = 'Fix login'): ChatRowT {
  return {
    chatId,
    hostId,
    name,
    folder: '/p',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 100,
    awaitingPermission: false,
    lastVisitedAt: 200,
    preview: 'hello',
    pendingPermissions: [],
    lastSeq: 1,
  };
}

function seed(...rows: ChatRowT[]): void {
  useChatStore.setState({
    activeChatId: null,
    chats: Object.fromEntries(rows.map((r) => [r.chatId, r])),
  });
}

beforeEach(() => {
  __resetRouterMock();
  reportHost('d1', { hostName: 'Hetzner' });
  reportHost('d2', { hostName: 'Mac' });
});

describe('ChatRowItem — host label', () => {
  it('shows the host when the title also names a chat on another host', () => {
    const a = makeRow('c1', 'd1');
    const b = makeRow('c2', 'd2');
    seed(a, b);
    const r = renderRN(<ChatRowItem row={a} />);
    expect(textOf(findHost(r.root, byTestId('row-host-c1')))).toBe('Hetzner');
  });

  it('shows no host for a unique title or a same-host duplicate', () => {
    const a = makeRow('c1', 'd1');
    seed(a, makeRow('c2', 'd1'), makeRow('c3', 'd2', 'Other'));
    const r = renderRN(<ChatRowItem row={a} />);
    expect(queryHost(r.root, byTestId('row-host-c1'))).toBeNull();
  });
});
