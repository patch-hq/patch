import { describe, expect, it } from 'vitest';
import { reorderManual } from '../stores/uiStore.js';
import { groupChats } from '../lib/chatGroups.js';
import type { ChatRow } from '../stores/chatStore.js';

const row = (chatId: string, createdAt: number): ChatRow =>
  ({
    chatId,
    hostId: 'h',
    folder: '/p',
    name: chatId,
    status: 'idle',
    createdAt,
    lastUpdated: createdAt,
    lastUserActivity: createdAt,
    jobId: null,
    pinnedAt: null,
  }) as unknown as ChatRow;

describe('reorderManual', () => {
  it('moves a chat before another and keeps unseen ids after', () => {
    expect(reorderManual(['x', 'a', 'b'], ['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b', 'x']);
  });
  it('throws when the target is not a sibling', () => {
    expect(() => reorderManual([], ['a'], 'a', 'zz')).toThrow();
  });
});

describe('manual chat sort', () => {
  it('follows the saved order, with unplaced chats first', () => {
    const g = groupChats([row('a', 1), row('b', 2), row('c', 3), row('new', 4)], [], {
      chatSort: 'manual',
      groupSort: 'same-as-chats',
      manualOrder: ['c', 'a', 'b'],
    });
    expect(g.folders[0]!.rows.map((r) => r.chatId)).toEqual(['new', 'c', 'a', 'b']);
  });
});
