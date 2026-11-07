import { describe, it, expect } from 'vitest';
import { parseReminderCommand } from '../lib/reminderCommand.js';

describe('parseReminderCommand (patch/todo.md — /remind)', () => {
  it('parses a cadence: `/remind every 10 turns <text>`', () => {
    expect(parseReminderCommand('/remind every 10 turns Hold the line')).toEqual({
      isReminder: true,
      reminder: 'Hold the line',
      every: { unit: 'turns', n: 10 },
    });
    expect(parseReminderCommand('/remind every 5 turns').error).toMatch(/needs text/);
  });

  it('recognises `/remind <text>` and returns the trimmed reminder', () => {
    expect(parseReminderCommand('/remind Do not touch the prod database')).toEqual({
      isReminder: true,
      reminder: 'Do not touch the prod database',
      every: null,
    });
  });

  it('is case-insensitive on the command word only', () => {
    expect(parseReminderCommand('/REMIND Keep the Casing')).toEqual({
      isReminder: true,
      reminder: 'Keep the Casing',
      every: null,
    });
  });

  it('treats a bare `/remind` as a clear (reminder null)', () => {
    expect(parseReminderCommand('/remind')).toEqual({
      isReminder: true,
      reminder: null,
      every: null,
    });
    expect(parseReminderCommand('/remind   ')).toEqual({
      isReminder: true,
      reminder: null,
      every: null,
    });
  });

  it('tolerates leading/trailing whitespace around the whole message', () => {
    expect(parseReminderCommand('  /remind  water the plants  ')).toEqual({
      isReminder: true,
      reminder: 'water the plants',
      every: null,
    });
  });

  it('does NOT match a normal message or a different slash command', () => {
    expect(parseReminderCommand('please remind me later')).toEqual({
      isReminder: false,
      reminder: null,
      every: null,
    });
    expect(parseReminderCommand('/reminders list them')).toEqual({
      isReminder: false,
      reminder: null,
      every: null,
    });
    expect(parseReminderCommand('/goal ship it')).toEqual({
      isReminder: false,
      reminder: null,
      every: null,
    });
  });
});
