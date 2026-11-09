// "Group by status" on the Chats tab (spec/15 § Chats tab → Grouping); mirrors
// packages/web's `groupByStatus`: same buckets, same order.

import { describe, it, expect } from 'vitest';
import { groupByStatus, SIDEBAR_GROUPINGS } from '../src/lib/statusGroups';
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

describe('groupByStatus', () => {
  it('buckets in desktop order: Failed, Waiting on you, Ready to review, Working, Done', () => {
    const groups = groupByStatus([
      row({ chatId: 'done', lastReadSeq: 5 }),
      row({ chatId: 'working', activity: 'running' }),
      row({ chatId: 'ready', lastReadSeq: 1 }),
      row({ chatId: 'waiting', activity: 'awaiting-permission' }),
      row({ chatId: 'failed', status: 'errored' }),
    ]);
    expect(groups.map((g) => g.label)).toEqual([
      'Failed',
      'Waiting on you',
      'Ready to review',
      'Working',
      'Done',
    ]);
    expect(groups.map((g) => g.rows.map((r) => r.chatId))).toEqual([
      ['failed'],
      ['waiting'],
      ['ready'],
      ['working'],
      ['done'],
    ]);
  });

  it('drops empty buckets and keeps arrival order within one', () => {
    const groups = groupByStatus([
      row({ chatId: 'b', activity: 'running' }),
      row({ chatId: 'a', activity: 'running' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows.map((r) => r.chatId)).toEqual(['b', 'a']);
  });

  it('puts a just-spawned chat under Working, never Ready to review', () => {
    const groups = groupByStatus([row({ chatId: 'new', lastSeq: 0, lastReadSeq: 0 })]);
    expect(groups.map((g) => g.label)).toEqual(['Working']);
  });

  it('offers the same two groupings as desktop', () => {
    expect(SIDEBAR_GROUPINGS.map((g) => g.label)).toEqual(['Group by project', 'Group by status']);
  });
});
