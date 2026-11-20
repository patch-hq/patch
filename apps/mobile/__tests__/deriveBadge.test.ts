// spec/15 § Status badges — parity with web's deriveBadge precedence
// (packages/web/src/__tests__/backgroundBadge.test.tsx), for the three
// states mobile's Chats list badge didn't draw at all: `errored`,
// `background`, `monitoring`. Ordering mirrors web: permission > errored >
// working > unread (`done`) > background > monitoring > read.

import { describe, it, expect } from 'vitest';
import { deriveBadge } from '../src/stores/types';
import type { ChatRow } from '../src/stores/types';

function row(overrides: Partial<ChatRow>): ChatRow {
  return {
    chatId: 'c1',
    name: 'One',
    hostId: 'd1',
    folder: '~/x',
    chatStatus: { state: 'idle', since: 0 },
    permissionMode: 'auto',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 0,
    awaitingPermission: false,
    lastReadSeq: 0,
    preview: '',
    pendingPermissions: [],
    lastSeq: 0,
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
  } as ChatRow;
}

describe('deriveBadge — agents', () => {
  it('running sub-agents get their own badge, ahead of background tasks', () => {
    expect(deriveBadge(row({ backgroundTasks: 2, runningAgents: 1 }))).toBe('agents');
    expect(deriveBadge(row({ backgroundTasks: 1, runningAgents: 0 }))).toBe('background');
  });

  it('NO FALLBACK: an unknown or zero agent count never shows agents', () => {
    expect(deriveBadge(row({ runningAgents: null }))).toBe('read');
    expect(deriveBadge(row({ runningAgents: 0 }))).toBe('read');
  });

  it('unread still beats agents', () => {
    expect(deriveBadge(row({ runningAgents: 1, lastSeq: 5, lastReadSeq: 1 }))).toBe('done');
  });
});

describe('deriveBadge — background', () => {
  it('replaces the read tick when a background task is still running', () => {
    expect(deriveBadge(row({}))).toBe('read');
    expect(deriveBadge(row({ backgroundTasks: 1 }))).toBe('background');
  });

  it('NO FALLBACK: an unknown or zero count never shows background', () => {
    expect(deriveBadge(row({ backgroundTasks: null }))).toBe('read');
    expect(deriveBadge(row({ backgroundTasks: 0 }))).toBe('read');
  });

  it('unread beats background, always', () => {
    expect(
      deriveBadge(row({ lastUpdated: 1, lastSeq: 1, lastReadSeq: 0, backgroundTasks: 1 })),
    ).toBe('done');
  });
});

describe('deriveBadge — monitoring', () => {
  it('shows monitoring when a wake is pending and there is nothing else to say', () => {
    expect(
      deriveBadge(row({ pendingWake: { message: 'check back', fireAt: 1, notAfter: undefined } })),
    ).toBe('monitoring');
  });

  it('unread still beats monitoring, same as background', () => {
    expect(
      deriveBadge(
        row({
          lastUpdated: 1,
          lastSeq: 1,
          lastReadSeq: 0,
          pendingWake: { message: 'check back', fireAt: 1, notAfter: undefined },
        }),
      ),
    ).toBe('done');
  });

  it('a running background job beats a monitoring wake — the job is the stronger claim', () => {
    expect(
      deriveBadge(
        row({
          backgroundTasks: 1,
          pendingWake: { message: 'check back', fireAt: 1, notAfter: undefined },
        }),
      ),
    ).toBe('background');
  });
});

describe('deriveBadge — failed is the server saying so', () => {
  it('a failed status is errored; the lifecycle flag alone is not', () => {
    expect(deriveBadge(row({ chatStatus: { state: 'failed', since: 0 } }))).toBe('errored');
    expect(deriveBadge(row({ status: 'errored' }))).toBe('read');
  });

  it('outranks background and monitoring', () => {
    const failed = { chatStatus: { state: 'failed', since: 0 } };
    expect(deriveBadge(row({ ...failed, backgroundTasks: 1 }))).toBe('errored');
    expect(
      deriveBadge(
        row({ ...failed, pendingWake: { message: 'check back', fireAt: 1, notAfter: undefined } }),
      ),
    ).toBe('errored');
  });
});

describe('deriveBadge — the phone never derives waiting on its own', () => {
  const perm = { requestId: 'r1', tool: 'Bash', description: undefined, args: {} };

  it('a pending card does not override the server status', () => {
    expect(
      deriveBadge(row({ chatStatus: { state: 'idle', since: 0 }, pendingPermissions: [perm] })),
    ).toBe('read');
    expect(
      deriveBadge(row({ chatStatus: { state: 'failed', since: 0 }, pendingPermissions: [perm] })),
    ).toBe('errored');
  });

  it('waiting for the user is permission, whatever kind of question it is', () => {
    const q = { statusKind: 'question', statusDeclared: true } as const;
    expect(deriveBadge(row({ ...q, chatStatus: { state: 'waiting_for_user', since: 0 } }))).toBe(
      'permission',
    );
    expect(deriveBadge(row(q))).toBe('read');
  });

  it('a declared report is not permission', () => {
    expect(deriveBadge(row({ statusKind: 'report', statusDeclared: true }))).toBe('read');
  });
});

describe('deriveBadge — mobile read/unread and full precedence', () => {
  it('visited at/after last update is read', () => {
    expect(deriveBadge(row({ lastUpdated: 5, lastSeq: 5, lastReadSeq: 5 }))).toBe('read');
    expect(deriveBadge(row({ lastUpdated: 5, lastSeq: 5, lastReadSeq: 9 }))).toBe('read');
  });
  it('working beats unread', () => {
    expect(
      deriveBadge(row({ chatStatus: { state: 'running', since: 0 }, lastUpdated: 5, lastSeq: 5, lastReadSeq: 0 })),
    ).toBe('working');
  });
  it('background beats monitoring beats read', () => {
    const wake = { message: 'm', fireAt: 1, notAfter: undefined };
    expect(deriveBadge(row({ backgroundTasks: 1, pendingWake: wake }))).toBe('background');
    expect(deriveBadge(row({ pendingWake: wake }))).toBe('monitoring');
  });
});
