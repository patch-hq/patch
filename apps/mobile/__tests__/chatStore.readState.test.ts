// Read state: a chat you have opened stays read — across a relaunch, and
// whatever the phone's clock says next to the server's.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { __clearAllMmkv } from './stubs/mmkv';
import type { ChatListEntry } from '../src/api/rest';

const ENTRY: ChatListEntry = {
  chatId: 'c1',
  name: 'Chat',
  hostId: 'd1',
  folder: '/f',
  activity: 'idle',
  permissionMode: 'auto',
  status: 'active',
  pinned: false,
  pinnedAt: null,
  lastUpdated: 1000,
  pendingWake: null,
  snoozedUntil: null,
};

async function freshStore() {
  vi.resetModules();
  const { useChatStore, deriveBadge } = await import('../src/stores/chatStore');
  const { toChatListRow } = await import('../src/lib/chatListRow');
  return { useChatStore, deriveBadge, toChatListRow };
}

beforeEach(() => {
  __clearAllMmkv();
});

describe('read state', () => {
  it('a chat opened before a relaunch is still read after it', async () => {
    const first = await freshStore();
    first.useChatStore.getState().hydrate([first.toChatListRow(ENTRY)]);
    expect(first.deriveBadge(first.useChatStore.getState().chats['c1']!)).toBe('done');
    first.useChatStore.getState().setActiveChat('c1');
    expect(first.deriveBadge(first.useChatStore.getState().chats['c1']!)).toBe('read');

    // The app is killed and relaunched: a new store, the roster fetched again.
    const second = await freshStore();
    second.useChatStore.getState().hydrate([second.toChatListRow(ENTRY)]);
    expect(second.deriveBadge(second.useChatStore.getState().chats['c1']!)).toBe('read');
  });

  it('news after the visit still shows as done after a relaunch', async () => {
    const first = await freshStore();
    first.useChatStore.getState().hydrate([first.toChatListRow(ENTRY)]);
    first.useChatStore.getState().setActiveChat('c1');

    const second = await freshStore();
    second.useChatStore.getState().hydrate([second.toChatListRow(ENTRY)]);
    second.useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'c1',
      seq: 5,
      role: 'assistant',
      content: 'news',
    });
    expect(second.deriveBadge(second.useChatStore.getState().chats['c1']!)).toBe('done');
  });

  it('a deleted chat leaves no read mark to be inherited by nothing', async () => {
    const first = await freshStore();
    first.useChatStore.getState().hydrate([first.toChatListRow(ENTRY)]);
    first.useChatStore.getState().setActiveChat('c1');
    first.useChatStore.getState().removeChat('c1');

    const second = await freshStore();
    second.useChatStore.getState().hydrate([second.toChatListRow(ENTRY)]);
    expect(second.useChatStore.getState().chats['c1']!.lastReadSeq).toBe(-1);
  });
});
