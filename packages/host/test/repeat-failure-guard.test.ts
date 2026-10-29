import { describe, expect, it } from 'vitest';
import { RepeatFailureGuard } from '../src/repeatFailureGuard.js';

function run(g: RepeatFailureGuard, chat: string, id: string, cmd: string, isError: boolean) {
  g.onToolUse(chat, id, 'Bash', { command: cmd });
  return g.onToolResult(chat, id, isError);
}

describe('RepeatFailureGuard', () => {
  it('trips on the Nth identical failure in a row', () => {
    const g = new RepeatFailureGuard(3);
    expect(run(g, 'c', '1', 'op read x', true)).toBeUndefined();
    expect(run(g, 'c', '2', 'op read x', true)).toBeUndefined();
    expect(run(g, 'c', '3', 'op read x', true)).toEqual({
      tool: 'Bash',
      count: 3,
      summary: 'op read x',
    });
  });

  it('a success or a different call ends the streak', () => {
    const g = new RepeatFailureGuard(3);
    run(g, 'c', '1', 'op read x', true);
    run(g, 'c', '2', 'op read x', true);
    run(g, 'c', '3', 'ls', false);
    expect(run(g, 'c', '4', 'op read x', true)).toBeUndefined();
    run(g, 'c', '5', 'op read x', true);
    run(g, 'c', '6', 'op read y', true);
    expect(run(g, 'c', '7', 'op read x', true)).toBeUndefined();
  });

  it('keeps chats separate and resets after tripping', () => {
    const g = new RepeatFailureGuard(2);
    run(g, 'a', '1', 'x', true);
    expect(run(g, 'b', '1', 'x', true)).toBeUndefined();
    expect(run(g, 'a', '2', 'x', true)).toBeDefined();
    expect(run(g, 'a', '3', 'x', true)).toBeUndefined();
  });

  it('clear forgets the streak', () => {
    const g = new RepeatFailureGuard(2);
    run(g, 'a', '1', 'x', true);
    g.clear('a');
    expect(run(g, 'a', '2', 'x', true)).toBeUndefined();
  });
});
