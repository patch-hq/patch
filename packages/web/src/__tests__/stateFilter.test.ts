// Filtering the chat list by state, and the errored badge that made it possible
// (lib/chatGroups.ts, stores/types.ts).
//
// The bug being fixed: a chat whose turn died read as FINISHED. `deriveBadge`
// had no errored case, so a failed chat fell through to `done`/`read` and looked
// identical in the sidebar to one that had succeeded — which is how a run of
// chats sat there with "You've hit your monthly spend limit" as their last word
// and nobody noticed.

import { describe, expect, it } from 'vitest';
import { deriveBadge, type ChatRow } from '../stores/types.js';
import { matchesStateFilter, needsAttention } from '../lib/chatGroups.js';

function row(over: Partial<ChatRow> = {}): ChatRow {
  return {
    chatId: 'c1',
    hostId: 'd1',
    name: 'a chat',
    preview: null,
    goal: null,
    goalProgress: null,
    lastGoal: null,
    reminder: null,
    statusSummary: null,
    statusKind: null,
    statusDeclared: null,
    todos: [],
    folder: '/w',
    chatStatus: { state: 'idle', since: 0 },
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    snoozedUntil: null,
    archivedAt: null,
    lastUpdated: 1,
    lastSeq: 1,
    lastReadSeq: 1,
    pendingPermissions: [],
    model: null,
    rateLimitResumingAt: null,
    resumeKind: null,
    ...(over as Partial<ChatRow>),
  } as ChatRow;
}

describe('deriveBadge — a failed chat is not a finished one', () => {
  it('badges an errored ACTIVITY as errored', () => {
    expect(deriveBadge(row({ chatStatus: { state: 'failed', since: 0 } }))).toBe('errored');
  });

  it('a lifecycle errored flag alone is not a failure: only the server status is', () => {
    expect(deriveBadge(row({ status: 'errored' }))).toBe('read');
  });

  it('still puts a pending decision first — that is answerable right now', () => {
    expect(
      deriveBadge(
        row({
          chatStatus: { state: 'waiting_for_user', since: 0 },
          pendingPermissions: [{ requestId: 'r', tool: 'Bash', description: undefined, args: {} }],
        }),
      ),
    ).toBe('permission');
  });

  it('does not badge a healthy chat as errored', () => {
    expect(deriveBadge(row({ chatStatus: { state: 'running', since: 0 } }))).toBe('working');
    expect(deriveBadge(row({ lastSeq: 5, lastReadSeq: 1 }))).toBe('done');
    expect(deriveBadge(row())).toBe('read');
  });
});

describe('needsAttention keeps failed chats in the queue', () => {
  it('a failed chat needs attention', () => {
    // Adding the errored badge took these OUT of `done`; without the errored
    // arm they would have silently dropped out of the queue entirely.
    expect(needsAttention(row({ chatStatus: { state: 'failed', since: 0 } }))).toBe(true);
  });

  it('a read, finished chat still does not', () => {
    expect(needsAttention(row())).toBe(false);
  });
});

describe('matchesStateFilter', () => {
  it('`all` filters nothing', () => {
    for (const r of [
      row(),
      row({ chatStatus: { state: 'failed', since: 0 } }),
      row({ chatStatus: { state: 'running', since: 0 } }),
    ]) {
      expect(matchesStateFilter(r, 'all')).toBe(true);
    }
  });

  it('`failed` shows only failures', () => {
    expect(matchesStateFilter(row({ chatStatus: { state: 'failed', since: 0 } }), 'failed')).toBe(
      true,
    );
    expect(matchesStateFilter(row({ chatStatus: { state: 'failed', since: 0 } }), 'failed')).toBe(
      true,
    );
    expect(matchesStateFilter(row({ chatStatus: { state: 'running', since: 0 } }), 'failed')).toBe(
      false,
    );
    expect(matchesStateFilter(row(), 'failed')).toBe(false);
  });

  it('`working` shows only running chats', () => {
    expect(matchesStateFilter(row({ chatStatus: { state: 'running', since: 0 } }), 'working')).toBe(
      true,
    );
    expect(matchesStateFilter(row({ chatStatus: { state: 'failed', since: 0 } }), 'working')).toBe(
      false,
    );
  });

  it('`waiting` covers a permission prompt AND an agent stopped on a question', () => {
    expect(
      matchesStateFilter(row({ chatStatus: { state: 'waiting_for_user', since: 0 } }), 'waiting'),
    ).toBe(true);
    // A declared question is waiting because the server says so, not because
    // the surface reads the row's statusKind.
    expect(
      matchesStateFilter(
        row({
          statusKind: 'question',
          statusDeclared: true,
          chatStatus: { state: 'waiting_for_user', since: 0 },
        }),
        'waiting',
      ),
    ).toBe(true);
    expect(
      matchesStateFilter(row({ statusKind: 'question', statusDeclared: true }), 'waiting'),
    ).toBe(false);
    expect(matchesStateFilter(row({ chatStatus: { state: 'running', since: 0 } }), 'waiting')).toBe(
      false,
    );
  });

  it('`waiting` excludes a GENERATED question guess — only a declared one counts', () => {
    expect(
      matchesStateFilter(row({ statusKind: 'question', statusDeclared: false }), 'waiting'),
    ).toBe(false);
    expect(
      matchesStateFilter(row({ statusKind: 'question', statusDeclared: null }), 'waiting'),
    ).toBe(false);
  });

  it('`done` never includes a failure — the whole point of the filter', () => {
    expect(matchesStateFilter(row({ lastSeq: 5, lastReadSeq: 1 }), 'done')).toBe(true);
    expect(matchesStateFilter(row(), 'done')).toBe(true);
    expect(matchesStateFilter(row({ chatStatus: { state: 'failed', since: 0 } }), 'done')).toBe(
      false,
    );
  });

  it('agrees with the badge the row itself shows, for every filter', () => {
    // What you filter for and what you see must never disagree.
    const rows = [
      row({ chatStatus: { state: 'failed', since: 0 } }),
      row({ chatStatus: { state: 'running', since: 0 } }),
      row({ chatStatus: { state: 'waiting_for_user', since: 0 } }),
      row({ lastSeq: 5, lastReadSeq: 1 }),
      row(),
    ];
    for (const r of rows) {
      const shown = deriveBadge(r);
      const filters = (['failed', 'working', 'waiting', 'done'] as const).filter((f) =>
        matchesStateFilter(r, f),
      );
      // Waiting rows are the one overlap: they also count as Ready.
      const expected = shown === 'permission' ? 2 : 1;
      expect(filters.length, `${shown} must match ${expected} state filter(s)`).toBe(expected);
    }
  });

  it('`done` (Ready) includes chats waiting on the user', () => {
    expect(
      matchesStateFilter(row({ chatStatus: { state: 'waiting_for_user', since: 0 } }), 'done'),
    ).toBe(true);
  });
});

describe('a chat the server has not given a status yet', () => {
  it('is in no state filter: the surface assumes nothing', () => {
    const fresh = row({ chatStatus: undefined, lastSeq: 0, lastReadSeq: 0, lastUpdated: 0 });
    expect(matchesStateFilter(fresh, 'done')).toBe(false);
    expect(matchesStateFilter(fresh, 'working')).toBe(false);
    expect(matchesStateFilter(fresh, 'all')).toBe(true);
  });
});

describe('background work and the Ready view', () => {
  it('puts a chat with only background commands in Ready, not Working', () => {
    const r = row({ backgroundTasks: 2, runningAgents: 0 });
    expect(matchesStateFilter(r, 'done')).toBe(true);
    expect(matchesStateFilter(r, 'working')).toBe(false);
  });

  it('keeps a chat with a sub-agent running in Working, not Ready', () => {
    const r = row({ backgroundTasks: 2, runningAgents: 1 });
    expect(matchesStateFilter(r, 'done')).toBe(false);
    expect(matchesStateFilter(r, 'working')).toBe(true);
  });

  it('treats an unknown agent count as before: Working, not Ready', () => {
    for (const runningAgents of [null, undefined]) {
      const r = row({ backgroundTasks: 1, runningAgents });
      expect(matchesStateFilter(r, 'done')).toBe(false);
      expect(matchesStateFilter(r, 'working')).toBe(true);
    }
  });
});
