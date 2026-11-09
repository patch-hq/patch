// The chat list's preview and unread state for chats the phone has not
// subscribed to: they come from the roster and `chat.state`, not live messages.

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

describe('latest message without a subscription', () => {
  it('the roster supplies the preview and seq, so a visited chat that was answered is unread', async () => {
    const s = await freshStore();
    s.useChatStore
      .getState()
      .hydrate([s.toChatListRow({ ...ENTRY, lastMessagePreview: 'first answer', lastSeq: 4 })]);
    s.useChatStore.getState().setActiveChat('c1');
    s.useChatStore.getState().setActiveChat(null);
    expect(s.deriveBadge(s.useChatStore.getState().chats['c1']!)).toBe('read');

    s.useChatStore
      .getState()
      .hydrate([
        s.toChatListRow({ ...ENTRY, lastMessagePreview: 'the agent replied', lastSeq: 6 }),
      ]);
    const row = s.useChatStore.getState().chats['c1']!;
    expect(row.preview).toBe('the agent replied');
    expect(row.lastSeq).toBe(6);
    expect(s.deriveBadge(row)).toBe('done');
  });

  it('a chat.state carries the latest message and seq', async () => {
    const s = await freshStore();
    s.useChatStore.getState().hydrate([s.toChatListRow(ENTRY)]);
    s.useChatStore.getState().applyEvent({
      type: 'chat.state',
      chatId: 'c1',
      permissionMode: 'auto',
      activity: 'idle',
      lastUpdated: 2000,
      lastSeq: 9,
      lastMessagePreview: 'done and dusted',
    } as never);
    const row = s.useChatStore.getState().chats['c1']!;
    expect(row.preview).toBe('done and dusted');
    expect(row.lastSeq).toBe(9);
  });

  it('a frame that reaches less far than a live message does not replace its preview', async () => {
    const s = await freshStore();
    s.useChatStore
      .getState()
      .hydrate([s.toChatListRow({ ...ENTRY, lastMessagePreview: 'old', lastSeq: 3 })]);
    s.useChatStore.getState().applyEvent({
      type: 'chat.state',
      chatId: 'c1',
      permissionMode: 'auto',
      activity: 'idle',
      lastUpdated: 2000,
      lastSeq: 2,
      lastMessagePreview: 'older still',
    } as never);
    expect(s.useChatStore.getState().chats['c1']!.preview).toBe('old');
  });

  it('an older server that sends neither field leaves the row as it was', async () => {
    const s = await freshStore();
    s.useChatStore.getState().hydrate([s.toChatListRow(ENTRY)]);
    expect(s.useChatStore.getState().chats['c1']!.preview).toBeNull();
    expect(s.useChatStore.getState().chats['c1']!.lastSeq).toBe(0);
  });
});
