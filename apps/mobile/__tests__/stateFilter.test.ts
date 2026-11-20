// Filtering the Chats tab list by state (spec/15 § Chats tab; mirrors
// packages/web/src/__tests__/stateFilter.test.ts's `matchesStateFilter`
// coverage — same behaviour, ported field for field).

import { describe, it, expect } from 'vitest';
import { matchesStateFilter } from '../src/lib/stateFilter';
import type { ChatRow } from '../src/stores/types';

function row(overrides: Partial<ChatRow> & { chatId: string }): ChatRow {
  return {
    name: null,
    hostId: 'd1',
    folder: '~/proj',
    chatStatus: { state: 'idle', since: 0 },
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

describe('matchesStateFilter', () => {
  it('`all` filters nothing', () => {
    for (const r of [row({ chatId: 'a' }), row({ chatId: 'a', chatStatus: { state: 'failed', since: 0 } })]) {
      expect(matchesStateFilter(r, 'all')).toBe(true);
    }
  });

  it('`failed` shows only failures', () => {
    expect(matchesStateFilter(row({ chatId: 'a', chatStatus: { state: 'failed', since: 0 } }), 'failed')).toBe(true);
    expect(matchesStateFilter(row({ chatId: 'a', chatStatus: { state: 'failed', since: 0 } }), 'failed')).toBe(true);
    expect(matchesStateFilter(row({ chatId: 'a', chatStatus: { state: 'running', since: 0 } }), 'failed')).toBe(false);
    expect(matchesStateFilter(row({ chatId: 'a' }), 'failed')).toBe(false);
  });

  it('`working` includes background and monitoring, not just a live turn', () => {
    expect(matchesStateFilter(row({ chatId: 'a', chatStatus: { state: 'running', since: 0 } }), 'working')).toBe(true);
    expect(matchesStateFilter(row({ chatId: 'a', backgroundTasks: 1 }), 'working')).toBe(true);
    expect(
      matchesStateFilter(
        row({ chatId: 'a', pendingWake: { message: 'check back', fireAt: 1 } }),
        'working',
      ),
    ).toBe(true);
    expect(matchesStateFilter(row({ chatId: 'a', chatStatus: { state: 'failed', since: 0 } }), 'working')).toBe(false);
  });

  it('`waiting` covers a permission prompt AND a declared question', () => {
    expect(
      matchesStateFilter(row({ chatId: 'a', chatStatus: { state: 'waiting_for_user', since: 0 } }), 'waiting'),
    ).toBe(true);
    expect(
      matchesStateFilter(
        row({
          chatId: 'a',
          statusKind: 'question',
          statusDeclared: true,
          chatStatus: { state: 'waiting_for_user', since: 0 },
        }),
        'waiting',
      ),
    ).toBe(true);
    // Never from the row's own statusKind: only the server's status says waiting.
    expect(
      matchesStateFilter(row({ chatId: 'a', statusKind: 'question', statusDeclared: true }), 'waiting'),
    ).toBe(false);
    expect(matchesStateFilter(row({ chatId: 'a', chatStatus: { state: 'running', since: 0 } }), 'waiting')).toBe(false);
  });

  it('`waiting` excludes a GENERATED question guess — only a declared one counts', () => {
    expect(
      matchesStateFilter(
        row({ chatId: 'a', statusKind: 'question', statusDeclared: false }),
        'waiting',
      ),
    ).toBe(false);
  });

  it('`done` (Ready) includes chats waiting on the user', () => {
    expect(matchesStateFilter(row({ chatId: 'a', chatStatus: { state: 'waiting_for_user', since: 0 } }), 'done')).toBe(
      true,
    );
    expect(
      matchesStateFilter(
        row({ chatId: 'a', statusKind: 'question', statusDeclared: true }),
        'done',
      ),
    ).toBe(true);
  });

  it('`done` never includes a failure', () => {
    expect(
      matchesStateFilter(
        row({ chatId: 'a', lastUpdated: 10, lastSeq: 10, lastReadSeq: 5 }),
        'done',
      ),
    ).toBe(true);
    expect(matchesStateFilter(row({ chatId: 'a' }), 'done')).toBe(true);
    expect(matchesStateFilter(row({ chatId: 'a', chatStatus: { state: 'failed', since: 0 } }), 'done')).toBe(false);
  });
});

describe('a chat the server has not given a status yet', () => {
  it('is in no state filter: the phone assumes nothing', () => {
    const fresh = row({ chatId: 'n', chatStatus: undefined, lastSeq: 0, lastReadSeq: 0, lastUpdated: 0 });
    expect(matchesStateFilter(fresh, 'done')).toBe(false);
    expect(matchesStateFilter(fresh, 'working')).toBe(false);
  });
});
