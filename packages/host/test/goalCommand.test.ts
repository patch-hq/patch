import { describe, expect, it } from 'vitest';
import { parseLeadingGoal } from '../src/goalCommand.js';

describe('parseLeadingGoal', () => {
  it('ignores text that does not start with /goal', () => {
    expect(parseLeadingGoal('set a /goal later')).toBeNull();
    expect(parseLeadingGoal('/goalpost')).toBeNull();
    expect(parseLeadingGoal('hello')).toBeNull();
  });
  it('takes the text after /goal as goal and turn', () => {
    expect(parseLeadingGoal('/goal ship it')).toEqual({ goal: 'ship it', message: 'ship it' });
    expect(parseLeadingGoal('  /GOAL ship\nit ')).toEqual({
      goal: 'ship\nit',
      message: 'ship\nit',
    });
  });
  it('treats a bare /goal as a clear with nothing to send', () => {
    expect(parseLeadingGoal('/goal')).toEqual({ goal: null, message: '' });
  });
});
