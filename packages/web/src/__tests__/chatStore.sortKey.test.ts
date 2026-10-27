// spec/14 § Sidebar ordering — the list is sorted by the user's own last
// activity. The cold-start snapshot must carry it, or every row starts at zero
// and only jumps to its real place when its agent next does something.
import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../stores/chatStore.js';

const row = (chatId: string, lastUserActivity: number | undefined, lastUpdated = 5_000) => ({
  chatId,
  name: chatId,
  hostId: 'h',
  folder: '/p',
  permissionMode: 'auto' as const,
  activity: 'idle' as const,
  status: 'active' as const,
  pinned: false,
  pinnedAt: null,
  disabled: false,
  lastUpdated,
  jobId: null,
  ...(lastUserActivity !== undefined ? { lastUserActivity } : {}),
});

describe('sidebar sort key from REST snapshots', () => {
  beforeEach(() => useChatStore.getState()._reset());

  it('hydrate keeps the snapshot value', () => {
    useChatStore.getState().hydrate([row('a', 1_000)]);
    expect(useChatStore.getState().chats['a']!.lastUserActivity).toBe(1_000);
  });

  it('a snapshot older than the live value does not pull the row back down', () => {
    useChatStore.getState().hydrate([row('a', 1_000)]);
    useChatStore.getState().hydrate([row('a', 2_000)]);
    useChatStore.getState().hydrate([row('a', 1_000)]);
    expect(useChatStore.getState().chats['a']!.lastUserActivity).toBe(2_000);
  });

  it('a server that omits the field reads as lastUpdated', () => {
    useChatStore.getState().hydrate([row('a', undefined, 7_000)]);
    expect(useChatStore.getState().chats['a']!.lastUserActivity).toBe(7_000);
  });

  it('mergeChats carries it too', () => {
    useChatStore.getState().hydrate([]);
    useChatStore.getState().mergeChats([row('b', 3_000)]);
    expect(useChatStore.getState().chats['b']!.lastUserActivity).toBe(3_000);
  });
});
