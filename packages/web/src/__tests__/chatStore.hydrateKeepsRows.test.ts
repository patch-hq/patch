// A reconnect refetches `GET /api/chats`, which by design leaves out archived,
// deleted, hidden and snoozed chats. Those rows reach the store through their
// own sections; a refetch must not drop them and leave them to be refilled.
import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../stores/chatStore.js';

function row(chatId: string, extra: Record<string, unknown> = {}): never {
  return {
    chatId,
    hostId: 'd1',
    permissionMode: 'auto',
    name: chatId,
    folder: '/tmp/x',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 1000,
    ...extra,
  } as never;
}

describe('hydrate keeps rows the default snapshot excludes', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
  });

  it('keeps archived, hidden and snoozed rows across a refetch, and still drops a vanished active row', () => {
    const s = useChatStore.getState();
    s.hydrate([row('a'), row('gone')]);
    s.mergeChats([
      row('arch', { status: 'archived' }),
      row('hid', { hidden: true }),
      row('snz', { snoozedUntil: Date.now() + 3_600_000 }),
    ]);
    useChatStore.getState().hydrate([row('a')]);
    const ids = Object.keys(useChatStore.getState().chats).sort();
    expect(ids).toEqual(['a', 'arch', 'hid', 'snz']);
  });

  it('a row that comes back in the snapshot is refreshed, not duplicated', () => {
    const s = useChatStore.getState();
    s.hydrate([row('a')]);
    s.mergeChats([row('arch', { status: 'archived' })]);
    useChatStore
      .getState()
      .hydrate([row('a'), row('arch', { status: 'active', lastUpdated: 2000 })]);
    expect(useChatStore.getState().chats['arch']?.status).toBe('active');
  });
});
