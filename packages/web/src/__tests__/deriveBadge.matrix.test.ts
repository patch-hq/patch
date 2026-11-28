// spec/14 § Status badges, spec/05 § Chat status — what the chat is doing is the
// server's status alone; the surface adds only its read mark and the quiet work
// the server reports alongside. Nothing the surface holds overrides the status.

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
    ...over,
  } as ChatRow;
}

const st = (state: string): Partial<ChatRow> => ({ chatStatus: { state, since: 0 } });

describe('deriveBadge — the server status decides', () => {
  it.each<[string, Partial<ChatRow>, DisplayBadge]>([
    ['idle, read', st('idle'), 'read'],
    ['running', st('running'), 'working'],
    ['waiting for the user', st('waiting_for_user'), 'permission'],
    ['failed', st('failed'), 'errored'],
    ['interrupted', st('interrupted'), 'interrupted'],
    ['waiting for sign-in', st('waiting_for_sign_in'), 'signin'],
    ['paused', st('paused'), 'paused'],
    ['host offline', st('host_offline'), 'away'],
    ['host restarting', st('host_restarting'), 'away'],
    ['queued for an offline host', st('queued_offline'), 'away'],
    ['idle with unread output', { ...st('idle'), lastSeq: 5, lastReadSeq: 1 }, 'done'],
    ['idle with agents running', { ...st('idle'), runningAgents: 1, backgroundTasks: 2 }, 'agents'],
    ['idle with a background task', { ...st('idle'), backgroundTasks: 1 }, 'background'],
    ['idle with a self-wake armed', { ...st('idle'), pendingWake: WAKE }, 'monitoring'],
  ])('%s → %s', (_name, over, expected) => {
    expect(deriveBadge(row(over))).toBe(expected);
  });
});

describe('deriveBadge — the surface never derives a status of its own', () => {
  it('a pending permission card does not make an idle chat "needs you"', () => {
    expect(deriveBadge(row({ pendingPermissions: [PERM] }))).toBe('read');
  });

  it('a declared question does not either: the server says waiting when it is', () => {
    expect(deriveBadge(row({ statusKind: 'question', statusDeclared: true }))).toBe('read');
  });

  it('a lifecycle `errored` flag does not override the server status', () => {
    expect(deriveBadge(row({ status: 'errored' }))).toBe('read');
  });

  it('before the server has spoken, no status is shown, only the read mark', () => {
    expect(deriveBadge(row({ chatStatus: undefined }))).toBe('read');
    expect(deriveBadge(row({ chatStatus: undefined, lastSeq: 3, lastReadSeq: 1 }))).toBe('done');
  });

  it('a status this surface does not know reads as no status, never a neighbour', () => {
    expect(deriveBadge(row(st('something_new')))).toBe('read');
  });

  it('a failure outranks unread output; a pause and an away host are below it', () => {
    expect(deriveBadge(row({ ...st('failed'), lastSeq: 5, lastReadSeq: 1 }))).toBe('errored');
    expect(deriveBadge(row({ ...st('paused'), lastSeq: 5, lastReadSeq: 1 }))).toBe('done');
    expect(deriveBadge(row({ ...st('host_offline'), lastSeq: 5, lastReadSeq: 1 }))).toBe('done');
  });
});

describe('unread counts agent messages, not every record the log gains', () => {
  it('stays read when only notes, call summaries or tool rows arrived after the last agent message', () => {
    expect(deriveBadge(row({ lastSeq: 40, lastMessageSeq: 30, lastReadSeq: 30 }))).not.toBe('done');
  });

  it('goes unread when an agent message arrived after the last visit', () => {
    expect(deriveBadge(row({ lastSeq: 40, lastMessageSeq: 38, lastReadSeq: 30 }))).toBe('done');
  });

  it('keeps the old rule for a host that does not report the agent-message seq', () => {
    expect(deriveBadge(row({ lastSeq: 40, lastReadSeq: 30 }))).toBe('done');
  });
});
