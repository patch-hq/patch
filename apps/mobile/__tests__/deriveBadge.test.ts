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
    activity: 'idle',
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

describe('deriveBadge — errored', () => {
  it('ranks above working and below permission', () => {
    expect(deriveBadge(row({ status: 'errored' }))).toBe('errored');
    expect(deriveBadge(row({ activity: 'errored' }))).toBe('errored');
    expect(deriveBadge(row({ status: 'errored', activity: 'running' }))).toBe('errored');
    expect(deriveBadge(row({ status: 'errored', activity: 'awaiting-permission' }))).toBe(
      'permission',
    );
  });

  it('outranks background and monitoring', () => {
    expect(deriveBadge(row({ status: 'errored', backgroundTasks: 1 }))).toBe('errored');
    expect(
      deriveBadge(
        row({
          status: 'errored',
          pendingWake: { message: 'check back', fireAt: 1, notAfter: undefined },
        }),
      ),
    ).toBe('errored');
  });
});

describe('deriveBadge — parity with web for the permission signals', () => {
  const perm = { requestId: 'r1', tool: 'Bash', description: undefined, args: {} };

  it('a pending permission outlives activity going idle', () => {
    expect(deriveBadge(row({ activity: 'idle', pendingPermissions: [perm] }))).toBe('permission');
  });

  it('a pending permission beats errored', () => {
    expect(deriveBadge(row({ activity: 'errored', pendingPermissions: [perm] }))).toBe(
      'permission',
    );
  });

  it('a DECLARED question is permission, even over errored/running', () => {
    const q = { statusKind: 'question', statusDeclared: true } as const;
    expect(deriveBadge(row(q))).toBe('permission');
    expect(deriveBadge(row({ ...q, activity: 'running' }))).toBe('permission');
    expect(deriveBadge(row({ ...q, activity: 'errored' }))).toBe('permission');
  });

  it('a GENERATED question does not read as permission', () => {
    expect(deriveBadge(row({ statusKind: 'question', statusDeclared: false }))).toBe('read');
    expect(deriveBadge(row({ statusKind: 'question', statusDeclared: null }))).toBe('read');
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
  it('open tool calls make a quiet chat working', () => {
    expect(deriveBadge(row({ openToolCalls: 1 }))).toBe('working');
  });
  it('working beats unread', () => {
    expect(
      deriveBadge(row({ activity: 'running', lastUpdated: 5, lastSeq: 5, lastReadSeq: 0 })),
    ).toBe('working');
  });
  it('background beats monitoring beats read', () => {
    const wake = { message: 'm', fireAt: 1, notAfter: undefined };
    expect(deriveBadge(row({ backgroundTasks: 1, pendingWake: wake }))).toBe('background');
    expect(deriveBadge(row({ pendingWake: wake }))).toBe('monitoring');
  });
});
