import { describe, expect, it } from 'vitest';
import { threadRowState, type ThreadRankInput } from '../src/index.js';

function row(chatId: string, over: Partial<ThreadRankInput> = {}): ThreadRankInput {
  return {
    chatId,
    status: 'active',
    chatStatus: { state: 'idle' },
    lastUpdated: 1,
    snoozedUntil: null,
    pendingPermissions: [],
    statusKind: null,
    statusDeclared: null,
    ...over,
  };
}

describe('threadRowState', () => {
  it('ranks a pending permission, then a declared question, report, running, idle', () => {
    const waiting = { chatStatus: { state: 'waiting_for_user' } };
    expect(threadRowState(row('a', { ...waiting, pendingPermissions: [{}] }))).toBe('permission');
    expect(threadRowState(row('a', waiting))).toBe('permission');
    expect(
      threadRowState(row('a', { ...waiting, statusKind: 'question', statusDeclared: true })),
    ).toBe('question');
    // The surface never ranks a row as blocked on its own: only the server's status does.
    expect(threadRowState(row('a', { pendingPermissions: [{}] }))).toBe('idle');
    expect(threadRowState(row('a', { statusKind: 'report' }))).toBe('report');
    expect(threadRowState(row('a', { chatStatus: { state: 'running' } }))).toBe('working');
    expect(threadRowState(row('a'))).toBe('idle');
  });

  it('does not treat a generated question guess as blocked', () => {
    expect(threadRowState(row('a', { statusKind: 'question', statusDeclared: false }))).toBe(
      'idle',
    );
  });
});
