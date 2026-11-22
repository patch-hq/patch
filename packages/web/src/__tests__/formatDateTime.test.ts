import { describe, expect, it } from 'vitest';
import { formatClock, formatDateTime, formatDay, formatWhen } from '../lib/formatDateTime.js';

const AT = new Date(2026, 11, 17, 10, 16).getTime();

describe('formatDateTime', () => {
  it('is one 24-hour, day-first format', () => {
    expect(formatClock(AT)).toBe('10:16');
    expect(formatDay(AT, AT)).toBe('17 Dec');
    expect(formatDateTime(AT, AT)).toBe('17 Dec 10:16');
  });

  it('adds the year only when it is not this one', () => {
    expect(formatDay(AT, AT + 400 * 86_400_000)).toMatch(/2026/);
  });

  it('drops the date for today', () => {
    expect(formatWhen(AT, AT + 60_000)).toBe('10:16');
    expect(formatWhen(AT, AT + 86_400_000)).toBe('17 Dec 10:16');
  });
});
