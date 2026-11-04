// Needs-attention filter + FIFO queue (spec/15 § Needs attention; mirrors
// packages/web/src/lib/chatGroups.ts's `needsAttention` / `sortAttentionQueue`
// test coverage).

import { describe, it, expect } from 'vitest';
import { needsAttention, sortAttentionQueue } from '../src/lib/attentionQueue';
import type { ChatRow } from '../src/stores/types';

function row(overrides: Partial<ChatRow> & { chatId: string }): ChatRow {
  return {
    name: null,
    hostId: 'd1',
    folder: '~/proj',
    activity: 'idle',
    permissionMode: 'bypassPermissions',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 0,
    awaitingPermission: false,
    lastReadSeq: 5,
    preview: null,
    pendingPermissions: [],
    lastSeq: 5,
    pendingWake: null,
    snoozedUntil: null,
    backgroundTasks: null,
    model: null,
    jobId: null,
    statusSummary: null,
    statusKind: null,
    statusDeclared: null,
    goal: null,
    reminder: null,
    todos: [],
    disabled: false,
    ...overrides,
  };
}

describe('needsAttention', () => {
  it('is true for a done (finished, unread) chat', () => {
    expect(needsAttention(row({ chatId: 'a', lastUpdated: 10, lastSeq: 10, lastReadSeq: 5 }))).toBe(
      true,
    );
  });

  it('is true for a permission (awaiting-permission) chat', () => {
    expect(needsAttention(row({ chatId: 'a', activity: 'awaiting-permission' }))).toBe(true);
  });

  it('is true for an errored chat', () => {
    expect(needsAttention(row({ chatId: 'a', activity: 'errored' }))).toBe(true);
    expect(needsAttention(row({ chatId: 'a', status: 'errored' as ChatRow['status'] }))).toBe(true);
  });

  it('is true for a declared question, even once read', () => {
    expect(
      needsAttention(
        row({
          chatId: 'a',
          statusKind: 'question',
          statusDeclared: true,
          lastUpdated: 5,
          lastSeq: 5,
          lastReadSeq: 9,
        }),
      ),
    ).toBe(true);
  });

  it('is false for an UNdeclared question — only a declared one needs attention', () => {
    expect(
      needsAttention(
        row({
          chatId: 'a',
          statusKind: 'question',
          statusDeclared: false,
          lastUpdated: 5,
          lastSeq: 5,
          lastReadSeq: 9,
        }),
      ),
    ).toBe(false);
  });

  it('is true for a report, even once read', () => {
    expect(
      needsAttention(
        row({ chatId: 'a', statusKind: 'report', lastUpdated: 5, lastSeq: 5, lastReadSeq: 9 }),
      ),
    ).toBe(true);
  });

  it('is false for a working (still going) chat', () => {
    expect(needsAttention(row({ chatId: 'a', activity: 'running' }))).toBe(false);
  });

  it('is false for an already-read chat with no declared question/report', () => {
    expect(needsAttention(row({ chatId: 'a', lastUpdated: 5, lastSeq: 5, lastReadSeq: 9 }))).toBe(
      false,
    );
  });

  it('is false for background/monitoring — not yet a result to look at', () => {
    expect(
      needsAttention(
        row({ chatId: 'a', lastUpdated: 5, lastSeq: 5, lastReadSeq: 9, backgroundTasks: 2 }),
      ),
    ).toBe(false);
    expect(
      needsAttention(
        row({
          chatId: 'a',
          lastUpdated: 5,
          lastSeq: 5,
          lastReadSeq: 9,
          pendingWake: { message: 'check back', fireAt: 1 },
        }),
      ),
    ).toBe(false);
  });
});

describe('sortAttentionQueue', () => {
  const r = (chatId: string, o: Partial<Parameters<typeof row>[0]> = {}) =>
    row({ chatId, lastSeq: 5, lastReadSeq: 0, ...o });

  it("orders by the user's last activity, newest first", () => {
    const rows = [
      r('a', { lastUserActivity: 100 }),
      r('c', { lastUserActivity: 300 }),
      r('b', { lastUserActivity: 200 }),
    ];
    expect(sortAttentionQueue(rows).map((x) => x.chatId)).toEqual(['c', 'b', 'a']);
  });

  it('agent activity and a permission prompt do not move a row', () => {
    const before = [r('a', { lastUserActivity: 200 }), r('b', { lastUserActivity: 100 })];
    const after = [
      r('a', { lastUserActivity: 200, lastUpdated: 999 }),
      r('b', { lastUserActivity: 100, activity: 'awaiting-permission', lastUpdated: 999 }),
    ];
    expect(sortAttentionQueue(before).map((x) => x.chatId)).toEqual(['a', 'b']);
    expect(sortAttentionQueue(after).map((x) => x.chatId)).toEqual(['a', 'b']);
  });

  it('breaks a tie by chatId, stably', () => {
    const rows = [r('b', { lastUserActivity: 100 }), r('a', { lastUserActivity: 100 })];
    expect(sortAttentionQueue(rows).map((x) => x.chatId)).toEqual(['a', 'b']);
  });

  it('does not mutate the input array', () => {
    const rows = [r('b', { lastUserActivity: 100 }), r('a', { lastUserActivity: 200 })];
    const copy = [...rows];
    sortAttentionQueue(rows);
    expect(rows).toEqual(copy);
  });
});
