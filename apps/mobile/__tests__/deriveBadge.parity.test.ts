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
  chatStatus: { state: 'idle', since: 0 },
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
  // spec/05 § Chat status: the server's status decides, on both surfaces alike.
  [
    'server: waiting for the user',
    { chatStatus: { state: 'waiting_for_user', since: 1 } },
    'permission',
  ],
  ['server: failed', { chatStatus: { state: 'failed', since: 1 } }, 'errored'],
  ['server: interrupted', { chatStatus: { state: 'interrupted', since: 1 } }, 'interrupted'],
  ['server: sign-in', { chatStatus: { state: 'waiting_for_sign_in', since: 1 } }, 'signin'],
  ['server: paused', { chatStatus: { state: 'paused', since: 1 } }, 'paused'],
  ['server: host offline', { chatStatus: { state: 'host_offline', since: 1 } }, 'away'],
  ['server: idle beats an open call the surface saw', { openCallIds: ['k1'] }, 'read'],
  ['quiet', {}, 'read'],
  ['running', { chatStatus: { state: 'running', since: 0 } }, 'working'],
  ['awaiting permission', { chatStatus: { state: 'waiting_for_user', since: 0 } }, 'permission'],
  // A card or a declared question the server has not called waiting is no status.
  ['pending card alone', { pendingPermissions: [PERM] }, 'read'],
  ['declared question alone', { statusKind: 'question', statusDeclared: true }, 'read'],
  ['generated question', { statusKind: 'question', statusDeclared: false }, 'read'],
  ['errored', { chatStatus: { state: 'failed', since: 0 } }, 'errored'],
  ['unread', { lastSeq: 5, lastReadSeq: 4 }, 'done'],
  ['read ahead of seq', { lastSeq: 2, lastReadSeq: 9 }, 'read'],
  ['background', { backgroundTasks: 2 }, 'background'],
  ['monitoring', { pendingWake: WAKE }, 'monitoring'],
  [
    'unread while running',
    { chatStatus: { state: 'running', since: 0 }, lastSeq: 5, lastReadSeq: 1 },
    'working',
  ],
  [
    'unread with permission',
    {
      chatStatus: { state: 'waiting_for_user', since: 0 },
      pendingPermissions: [PERM],
      lastSeq: 5,
      lastReadSeq: 1,
    },
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
