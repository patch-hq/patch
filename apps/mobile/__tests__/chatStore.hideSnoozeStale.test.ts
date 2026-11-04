// A roster fetched before a hide / snooze lands after it must not undo it.
// Hide and snooze bump `lastUpdated`, which is how the store tells the two apart.

import { describe, it, expect, beforeEach } from 'vitest';
import type { WireEvent } from '@patch/wire';
import { useChatStore } from '../src/stores/chatStore';
import { toChatListRow } from '../src/lib/chatListRow';
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
  lastUpdated: 100,
  pendingWake: null,
  snoozedUntil: null,
  hidden: false,
};

const chat = () => useChatStore.getState().chats['c1']!;

beforeEach(() => {
  useChatStore.getState()._reset();
  useChatStore.getState().hydrate([toChatListRow(ENTRY)]);
});

describe('stale roster after hide / snooze', () => {
  it('a local hide survives a roster taken before it', () => {
    useChatStore.getState().setHidden('c1', true);
    useChatStore.getState().hydrate([toChatListRow(ENTRY)]);
    expect(chat().hidden).toBe(true);
  });

  it('a local snooze survives a roster taken before it', () => {
    useChatStore.getState().setSnoozed('c1', 9_999_999_999_999);
    useChatStore.getState().hydrate([toChatListRow(ENTRY)]);
    expect(chat().snoozedUntil).toBe(9_999_999_999_999);
  });

  it('a hide from another surface survives a roster taken before it', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      chatId: 'c1',
      activity: 'idle',
      permissionMode: 'auto',
      lastUpdated: 101,
      hidden: true,
    } as WireEvent);
    useChatStore.getState().hydrate([toChatListRow(ENTRY)]);
    expect(chat().hidden).toBe(true);
  });

  it('a newer roster still wins', () => {
    useChatStore.getState().setHidden('c1', true);
    useChatStore.getState().hydrate([toChatListRow({ ...ENTRY, lastUpdated: 500, hidden: false })]);
    expect(chat().hidden).toBe(false);
  });

  it('the host confirming a hide is applied after the local one', () => {
    useChatStore.getState().setHidden('c1', true);
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      chatId: 'c1',
      activity: 'idle',
      permissionMode: 'auto',
      lastUpdated: 101,
      hidden: false,
    } as WireEvent);
    expect(chat().hidden).toBe(false);
  });
});
