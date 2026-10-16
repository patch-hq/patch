// spec/14 § Status badges — the full precedence of deriveBadge, one rule per test.
// Order: permission > errored > working > done (unread) > background > monitoring > read.

import { describe, it, expect } from 'vitest';
import { deriveBadge, type ChatRow, type DisplayBadge } from '../stores/types.js';

const WAKE = { message: 'check back', fireAt: 1, notAfter: undefined };
const PERM = { requestId: 'r1', tool: 'Bash', description: undefined, args: {} };

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
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    snoozedUntil: null,
    lastUpdated: 1,
    lastSeq: 1,
    lastReadSeq: 1,
    pendingPermissions: [],
    pendingWake: null,
    jobId: null,
    model: null,
    permissionMode: 'auto',
    awaitingPermission: false,
    rateLimitResumingAt: null,
    resumeKind: null,
    ...over,
  } as ChatRow;
}

describe('deriveBadge — single signals', () => {
  it.each<[string, Partial<ChatRow>, DisplayBadge]>([
    ['quiet visited chat', {}, 'read'],
    ['running', { activity: 'running' }, 'working'],
    ['open tool call while idle', { openToolCalls: 1 }, 'working'],
    ['zero open tool calls', { openToolCalls: 0 }, 'read'],
    ['awaiting-permission activity', { activity: 'awaiting-permission' }, 'permission'],
    ['pending permission with idle activity', { pendingPermissions: [PERM] }, 'permission'],
    ['declared question', { statusKind: 'question', statusDeclared: true }, 'permission'],
    ['activity errored', { activity: 'errored' }, 'errored'],
    ['status errored', { status: 'errored' }, 'errored'],
    ['unread', { lastSeq: 5, lastReadSeq: 4 }, 'done'],
    ['background count', { backgroundTasks: 2 }, 'background'],
    ['pending wake', { pendingWake: WAKE }, 'monitoring'],
  ])('%s', (_n, over, want) => {
    expect(deriveBadge(row(over))).toBe(want);
  });
});

describe('deriveBadge — edges that must not trigger', () => {
  it('a GENERATED question does not read as permission', () => {
    expect(deriveBadge(row({ statusKind: 'question', statusDeclared: false }))).toBe('read');
    expect(deriveBadge(row({ statusKind: 'question', statusDeclared: null }))).toBe('read');
  });
  it('a declared report or complete is not permission', () => {
    expect(deriveBadge(row({ statusKind: 'report', statusDeclared: true }))).toBe('read');
    expect(deriveBadge(row({ statusKind: 'complete', statusDeclared: true }))).toBe('read');
  });
  it('lastReadSeq ahead of lastSeq is read, not unread', () => {
    expect(deriveBadge(row({ lastSeq: 2, lastReadSeq: 9 }))).toBe('read');
  });
  it('unknown / zero background counts never show background', () => {
    expect(deriveBadge(row({ backgroundTasks: null }))).toBe('read');
    expect(deriveBadge(row({ backgroundTasks: undefined }))).toBe('read');
    expect(deriveBadge(row({ backgroundTasks: 0 }))).toBe('read');
  });
});

describe('deriveBadge — pairwise precedence', () => {
  const signals: Array<[DisplayBadge, Partial<ChatRow>]> = [
    ['permission', { pendingPermissions: [PERM] }],
    ['errored', { status: 'errored' }],
    ['working', { activity: 'running' }],
    ['done', { lastSeq: 5, lastReadSeq: 1 }],
    ['background', { backgroundTasks: 1 }],
    ['monitoring', { pendingWake: WAKE }],
  ];
  for (let i = 0; i < signals.length; i++) {
    for (let j = i + 1; j < signals.length; j++) {
      const [hi, hiOver] = signals[i]!;
      const [lo, loOver] = signals[j]!;
      it(`${hi} beats ${lo}`, () => {
        expect(deriveBadge(row({ ...loOver, ...hiOver }))).toBe(hi);
        expect(deriveBadge(row({ ...hiOver, ...loOver }))).toBe(hi);
      });
    }
  }
  it('a pending permission outlives activity going idle', () => {
    expect(deriveBadge(row({ activity: 'idle', pendingPermissions: [PERM], lastSeq: 9 }))).toBe(
      'permission',
    );
  });
  it('a declared question beats errored and working', () => {
    const q = { statusKind: 'question', statusDeclared: true } as const;
    expect(deriveBadge(row({ ...q, activity: 'errored' }))).toBe('permission');
    expect(deriveBadge(row({ ...q, activity: 'running' }))).toBe('permission');
  });
});
