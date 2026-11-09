import { describe, it, expect } from 'vitest';
import { parseGoalCommand } from '../lib/goalCommand.js';

describe('parseGoalCommand (patch/todo.md — /goal)', () => {
  it('recognises `/goal <text>` and returns the trimmed goal', () => {
    expect(parseGoalCommand('/goal Ship the release by Friday')).toEqual({
      isGoal: true,
      goal: 'Ship the release by Friday',
      message: 'Ship the release by Friday',
    });
  });

  it('is case-insensitive on the command word only', () => {
    expect(parseGoalCommand('/GOAL Keep the Casing')).toEqual({
      isGoal: true,
      goal: 'Keep the Casing',
      message: 'Keep the Casing',
    });
  });

  it('treats a bare `/goal` as a clear (goal null)', () => {
    expect(parseGoalCommand('/goal')).toEqual({ isGoal: true, goal: null, message: '' });
    expect(parseGoalCommand('/goal   ')).toEqual({ isGoal: true, goal: null, message: '' });
  });

  it('treats `/goal clear` and its synonyms as a clear, never as a goal named "clear"', () => {
    for (const w of ['clear', 'CLEAR', 'off', 'none', 'cancel', 'remove', 'stop']) {
      expect(parseGoalCommand(`/goal ${w}`)).toEqual({ isGoal: true, goal: null, message: '' });
    }
    expect(parseGoalCommand('please stop /goal clear')).toEqual({
      isGoal: true,
      goal: null,
      message: 'please stop',
    });
  });

  it('still sets a goal when the clear word is only part of longer text', () => {
    expect(parseGoalCommand('/goal clear the backlog')).toEqual({
      isGoal: true,
      goal: 'clear the backlog',
      message: 'clear the backlog',
    });
  });

  it('tolerates leading/trailing whitespace around the whole message', () => {
    expect(parseGoalCommand('  /goal  finish the docs  ')).toEqual({
      isGoal: true,
      goal: 'finish the docs',
      message: 'finish the docs',
    });
  });

  it('does NOT match a normal message or a different slash command', () => {
    expect(parseGoalCommand('let us set a goal today')).toEqual({
      isGoal: false,
      goal: null,
      message: '',
    });
    expect(parseGoalCommand('/goalie save the shot')).toEqual({
      isGoal: false,
      goal: null,
      message: '',
    });
    expect(parseGoalCommand('/plan the week')).toEqual({ isGoal: false, goal: null, message: '' });
  });

  it('matches /goal anywhere in the message: text after is the goal, text before stays in the message', () => {
    expect(parseGoalCommand('please fix the build /goal all tests pass')).toEqual({
      isGoal: true,
      goal: 'all tests pass',
      message: 'please fix the build all tests pass',
    });
  });

  it('a trailing bare /goal clears the goal and keeps the text before it', () => {
    expect(parseGoalCommand('carry on /goal')).toEqual({
      isGoal: true,
      goal: null,
      message: 'carry on',
    });
  });

  it('does not match /goal glued to other characters', () => {
    expect(parseGoalCommand('see src/goal files')).toEqual({
      isGoal: false,
      goal: null,
      message: '',
    });
    expect(parseGoalCommand('a /goalie b')).toEqual({ isGoal: false, goal: null, message: '' });
  });
});
