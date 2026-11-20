import { describe, it, expect } from 'vitest';
import { isStoppable } from '../stores/types.js';

const perm = (tool: string) => ({ requestId: 'r', tool, description: '', args: {} });

describe('isStoppable', () => {
  it('is true while the agent is running', () => {
    expect(
      isStoppable({ chatStatus: { state: 'running', since: 0 }, pendingPermissions: [] }),
    ).toBe(true);
  });
  it('is false when parked only on an AskUserQuestion', () => {
    expect(
      isStoppable({
        chatStatus: { state: 'waiting_for_user', since: 0 },
        pendingPermissions: [perm('AskUserQuestion')],
      }),
    ).toBe(false);
  });
  it('is true when parked on an approval', () => {
    expect(
      isStoppable({
        chatStatus: { state: 'waiting_for_user', since: 0 },
        pendingPermissions: [perm('Bash')],
      }),
    ).toBe(true);
  });
  it('is false when idle', () => {
    expect(isStoppable({ chatStatus: { state: 'idle', since: 0 }, pendingPermissions: [] })).toBe(
      false,
    );
  });
});
