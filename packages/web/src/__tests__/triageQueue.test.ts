import { describe, expect, it } from 'vitest';
import type { ChatEventEntry } from '../stores/chatStore.js';
import type { ChatRow } from '../stores/types.js';
import { awaitsReply, lastAssistantMessage, triageQueue } from '../lib/triageQueue.js';

function row(over: Partial<ChatRow> = {}): ChatRow {
  return {
    chatId: 'c1',
    hostId: 'd1',
    name: 'a chat',
    preview: null,
    statusKind: null,
    statusDeclared: null,
    todos: [],
    folder: '/w',
    chatStatus: { state: 'idle', since: 0 },
    status: 'active',
    pinned: false,
    disabled: false,
    lastUpdated: 1,
    lastSeq: 5,
    lastReadSeq: 1,
    pendingPermissions: [],
    ...over,
  } as ChatRow;
}

const byId = (...rows: ChatRow[]): Record<string, ChatRow> =>
  Object.fromEntries(rows.map((r) => [r.chatId, r]));

describe('awaitsReply', () => {
  it('takes a finished, unread chat', () => {
    expect(awaitsReply(row())).toBe(true);
  });
  it('skips a chat already read', () => {
    expect(awaitsReply(row({ lastReadSeq: 5 }))).toBe(false);
  });
  it('skips a chat still working, archived or hidden', () => {
    expect(awaitsReply(row({ chatStatus: { state: 'running', since: 0 } }))).toBe(false);
    expect(awaitsReply(row({ status: 'archived' }))).toBe(false);
    expect(awaitsReply(row({ hidden: true }))).toBe(false);
  });
  it('skips a chat paused on a permission: a reply cannot grant it', () => {
    expect(
      awaitsReply(
        row({
          chatStatus: { state: 'waiting_for_user', since: 0 },
          pendingPermissions: [{ requestId: 'r' }] as ChatRow['pendingPermissions'],
        }),
      ),
    ).toBe(false);
  });
  it('keeps a declared question even once seen', () => {
    expect(
      awaitsReply(
        row({
          lastReadSeq: 5,
          statusKind: 'question',
          statusDeclared: true,
          chatStatus: { state: 'waiting_for_user', since: 0 },
        }),
      ),
    ).toBe(true);
  });
});

describe('triageQueue', () => {
  it('orders oldest first so a new arrival lands at the end', () => {
    const q = triageQueue(
      byId(row({ chatId: 'b', lastUpdated: 20 }), row({ chatId: 'a', lastUpdated: 10 })),
      new Map(),
    );
    expect(q.map((r) => r.chatId)).toEqual(['a', 'b']);
    const q2 = triageQueue(
      byId(
        row({ chatId: 'b', lastUpdated: 20 }),
        row({ chatId: 'a', lastUpdated: 10 }),
        row({ chatId: 'c', lastUpdated: 30 }),
      ),
      new Map(),
    );
    expect(q2.map((r) => r.chatId)).toEqual(['a', 'b', 'c']);
  });
  it('drops an answered chat until newer output arrives', () => {
    const chats = byId(row({ chatId: 'a', lastSeq: 5 }));
    expect(triageQueue(chats, new Map([['a', 5]]))).toEqual([]);
    const again = byId(row({ chatId: 'a', lastSeq: 9 }));
    expect(triageQueue(again, new Map([['a', 5]])).map((r) => r.chatId)).toEqual(['a']);
  });
});

describe('lastAssistantMessage', () => {
  const m = (role: 'user' | 'assistant', content: string, seq: number): ChatEventEntry =>
    ({ kind: 'message', role, content, seq }) as ChatEventEntry;
  it('returns the last assistant message, skipping later user turns', () => {
    expect(
      lastAssistantMessage([m('assistant', 'one', 1), m('assistant', 'two', 2), m('user', 'q', 3)]),
    ).toBe('two');
  });
  it('is null when nothing has loaded', () => {
    expect(lastAssistantMessage(undefined)).toBeNull();
    expect(lastAssistantMessage([m('user', 'q', 1)])).toBeNull();
  });
});
