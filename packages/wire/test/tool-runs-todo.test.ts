import { describe, expect, it } from 'vitest';
import { isGroupableToolCall, todoCardItems } from '../src/index.js';

describe('TodoWrite is a checklist card, not part of a run', () => {
  it('is never folded into a "Ran N commands" run', () => {
    expect(isGroupableToolCall('TodoWrite', { todos: [] })).toBe(false);
    expect(isGroupableToolCall('Bash', { command: 'ls' })).toBe(true);
  });

  it('reads the list from the call args', () => {
    expect(
      todoCardItems({
        todos: [
          { content: 'Diagnose', status: 'in_progress', activeForm: 'Diagnosing' },
          { content: 'Fix', status: 'pending' },
          { content: 'Verify', status: 'completed' },
        ],
      }),
    ).toEqual([
      { text: 'Diagnose', status: 'in_progress' },
      { text: 'Fix', status: 'pending' },
      { text: 'Verify', status: 'completed' },
    ]);
  });

  it('returns null for args that are not a todo list, so the ordinary row shows', () => {
    expect(todoCardItems({})).toBeNull();
    expect(todoCardItems({ todos: [] })).toBeNull();
    expect(todoCardItems({ todos: [{ content: 'x', status: 'bogus' }] })).toBeNull();
    expect(todoCardItems(null)).toBeNull();
  });
});
