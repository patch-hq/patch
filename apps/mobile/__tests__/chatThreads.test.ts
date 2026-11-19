// spec/04 § Provider switches — the Chats tab lists a thread of linked chats
// once, as its newest chat.

import { describe, it, expect } from 'vitest';
import { withoutContinued } from '../src/lib/chatThreads';

const ids = (rows: { chatId: string }[]): string[] => rows.map((r) => r.chatId);

describe('withoutContinued', () => {
  it('keeps only the newest chat of a thread', () => {
    expect(
      ids(
        withoutContinued([
          { chatId: 'a', status: 'active', continuedIn: 'b' },
          { chatId: 'b', status: 'active', continuedFrom: 'a', continuedIn: 'c' },
          { chatId: 'c', status: 'archived', continuedFrom: 'b' },
          { chatId: 'x', status: 'active' },
        ]),
      ),
    ).toEqual(['c', 'x']);
  });

  it('keeps an earlier chat whose continuation is deleted or not known here', () => {
    expect(
      ids(
        withoutContinued([
          { chatId: 'a', status: 'active', continuedIn: 'b' },
          { chatId: 'b', status: 'deleted', continuedFrom: 'a' },
          { chatId: 'c', status: 'active', continuedIn: 'gone' },
        ]),
      ),
    ).toEqual(['a', 'b', 'c']);
  });
});
