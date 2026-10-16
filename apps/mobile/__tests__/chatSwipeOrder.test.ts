import { describe, it, expect } from 'vitest';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { swipeNeighbours, swipeOrder } from '../src/lib/chatSwipeOrder';
import type { ChatRow } from '../src/stores/types';

function row(chatId: string, o: Partial<ChatRow> = {}): ChatRow {
  return {
    chatId,
    name: null,
    folder: '',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 0,
    lastUserActivity: 0,
    ...o,
  } as ChatRow;
}
const map = (rows: ChatRow[]): Record<string, ChatRow> =>
  Object.fromEntries(rows.map((r) => [r.chatId, r]));

describe('swipeOrder', () => {
  it('runs Manager, pinned (newest pin first), then folders A-Z with recent activity first', () => {
    const chats = map([
      row('b-old', { folder: 'b', lastUserActivity: 1 }),
      row('b-new', { folder: 'b', lastUserActivity: 9 }),
      row('a1', { folder: 'a', lastUserActivity: 5 }),
      row('p-old', { pinned: true, pinnedAt: 1, folder: 'z' }),
      row('p-new', { pinned: true, pinnedAt: 2, folder: 'a' }),
      row(SPECIAL_THREAD_IDS.manager),
    ]);
    expect(swipeOrder(chats)).toEqual([
      SPECIAL_THREAD_IDS.manager,
      'p-new',
      'p-old',
      'a1',
      'b-new',
      'b-old',
    ]);
  });

  it('leaves out channels, archived, deleted and hidden chats', () => {
    const chats = map([
      row('live', { folder: 'a' }),
      row(SPECIAL_THREAD_IDS.speakers),
      row('arch', { status: 'archived', folder: 'a' }),
      row('gone', { status: 'deleted', folder: 'a' }),
    ]);
    expect(swipeOrder(chats)).toEqual(['live']);
  });
});

describe('swipeNeighbours', () => {
  const chats = map([
    row('x', { folder: 'a', lastUserActivity: 3 }),
    row('y', { folder: 'a', lastUserActivity: 2 }),
    row('z', { folder: 'a', lastUserActivity: 1 }),
  ]);
  it('gives both sides in the middle', () => {
    expect(swipeNeighbours(chats, 'y')).toEqual({ prev: 'x', next: 'z' });
  });
  it('gives null past either end', () => {
    expect(swipeNeighbours(chats, 'x').prev).toBeNull();
    expect(swipeNeighbours(chats, 'z').next).toBeNull();
  });
  it('gives nothing for a chat outside the list', () => {
    expect(swipeNeighbours(chats, 'nope')).toEqual({ prev: null, next: null });
  });
});
