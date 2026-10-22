// Mobile must derive the same badge as web for every chat state (the device pass, done in code).
import { describe, it, expect } from 'vitest';
import { deriveBadge as mobile } from '../src/stores/types';
import { deriveBadge as web } from '../../../packages/web/src/stores/types';

const WAKE = { message: 'check back', fireAt: 1, notAfter: undefined };
const PERM = { requestId: 'r1', tool: 'Bash', description: undefined, args: {} };
const base = {
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
};

const states: Array<[string, Record<string, unknown>, string]> = [
  ['quiet', {}, 'read'],
  ['running', { activity: 'running' }, 'working'],
  ['open tool calls', { openToolCalls: 1 }, 'working'],
  ['zero tool calls', { openToolCalls: 0 }, 'read'],
  ['awaiting permission', { activity: 'awaiting-permission' }, 'permission'],
  ['pending permission', { pendingPermissions: [PERM] }, 'permission'],
  ['declared question', { statusKind: 'question', statusDeclared: true }, 'permission'],
  ['generated question', { statusKind: 'question', statusDeclared: false }, 'read'],
  ['errored', { activity: 'errored' }, 'errored'],
  ['unread', { lastSeq: 5, lastReadSeq: 4 }, 'done'],
  ['read ahead of seq', { lastSeq: 2, lastReadSeq: 9 }, 'read'],
  ['background', { backgroundTasks: 2 }, 'background'],
  ['monitoring', { pendingWake: WAKE }, 'monitoring'],
  ['unread while running', { activity: 'running', lastSeq: 5, lastReadSeq: 1 }, 'working'],
  [
    'unread with permission',
    { pendingPermissions: [PERM], lastSeq: 5, lastReadSeq: 1 },
    'permission',
  ],
];

describe('deriveBadge parity: mobile vs web', () => {
  it.each(states)('%s', (_n, over, want) => {
    const row = { ...base, ...over } as never;
    expect(web(row)).toBe(want);
    expect(mobile(row)).toBe(want);
  });
});
