// A roster refresh whose row carries `backgroundTasks: null` (server cold,
// nothing measured) must not wipe the live count — the bar would vanish while
// tasks still run. A real number, including 0, still lands.

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../src/stores/chatStore';
import type { ChatListRow } from '../src/stores/types';

function row(backgroundTasks?: number | null): ChatListRow {
  return {
    chatId: 'a',
    name: 'a',
    hostId: 'd1',
    folder: '/f',
    chatStatus: { state: 'idle', since: 0 },
    permissionMode: 'default',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 1,
    ...(backgroundTasks !== undefined ? { backgroundTasks } : {}),
  } as ChatListRow;
}

beforeEach(() => {
  useChatStore.getState()._reset();
});

describe('roster backgroundTasks', () => {
  it('keeps a known count when the row says null', () => {
    useChatStore.getState().hydrate([row(6)]);
    useChatStore.getState().hydrate([row(null)]);
    expect(useChatStore.getState().chats['a']?.backgroundTasks).toBe(6);
  });

  it('takes 0 as a real claim', () => {
    useChatStore.getState().hydrate([row(6)]);
    useChatStore.getState().hydrate([row(0)]);
    expect(useChatStore.getState().chats['a']?.backgroundTasks).toBe(0);
  });
});
