// The cold-start roster leaves archived chats out. A frame about a chat the
// roster never named (an archived chat that woke, a replayed event) is evidence
// about an existing chat, never a chat-creation event: `ensureRow` would draw it
// as a fresh ACTIVE row in the Chats list. Mirrors web's rostered-chat guard.

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../src/stores/chatStore';
import type { ChatListRow } from '../src/stores/types';

function row(chatId: string, status: 'active' | 'archived' = 'active'): ChatListRow {
  return {
    chatId,
    name: chatId,
    hostId: 'd1',
    folder: '/f',
    activity: 'idle',
    permissionMode: 'default',
    status,
    pinned: false,
    pinnedAt: null,
    lastUpdated: 1,
  } as ChatListRow;
}

const stateFrame = (chatId: string) =>
  ({
    type: 'chat.state',
    chatId,
    hostId: 'd1',
    activity: 'idle',
    permissionMode: 'default',
    lastUpdated: 5,
    folder: '/f',
  }) as never;

beforeEach(() => {
  useChatStore.getState()._reset();
});

describe('chatStore frames for chats outside the roster', () => {
  it('a chat.state for an unrostered (archived) chat does not create an active row', () => {
    useChatStore.getState().hydrate([row('a')]);
    useChatStore.getState().applyEvent(stateFrame('old-archived'));
    expect(useChatStore.getState().chats['old-archived']).toBeUndefined();
  });

  it('a chat.error for an unrostered chat does not create a row', () => {
    useChatStore.getState().hydrate([row('a')]);
    useChatStore.getState().applyEvent({
      type: 'chat.error',
      chatId: 'old-archived',
      error: { code: 'x', message: 'm' },
    } as never);
    expect(useChatStore.getState().chats['old-archived']).toBeUndefined();
  });

  it('chat.spawned still creates a row after hydrate, and later frames update it', () => {
    useChatStore.getState().hydrate([row('a')]);
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', chatId: 'new', hostId: 'd1', folder: '/f' } as never);
    useChatStore.getState().applyEvent(stateFrame('new'));
    expect(useChatStore.getState().chats['new']?.lastUpdated).toBe(5);
  });

  it('an archived row merged by the Archived section keeps receiving frames, staying archived', () => {
    useChatStore.getState().hydrate([row('a')]);
    useChatStore.getState().mergeRows([row('arch', 'archived')]);
    useChatStore.getState().applyEvent(stateFrame('arch'));
    expect(useChatStore.getState().chats['arch']?.status).toBe('archived');
  });

  it('before any roster has landed, frames still create rows (live stream beats the roster)', () => {
    useChatStore.getState().applyEvent(stateFrame('early'));
    expect(useChatStore.getState().chats['early']).toBeDefined();
  });
});
