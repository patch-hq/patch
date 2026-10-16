// Wake-time wording for the snooze sheet, toast and sidebar (spec/14 § Snooze
// sheet): HH:MM today, `Fri 08:00` within 6 days, `Thu 22 Oct` beyond — for
// every preset — plus the elapsed-time and divider wording.

import { describe, it, expect } from 'vitest';
import {
  SNOOZE_PRESETS,
  formatElapsed,
  formatSnoozeMoment,
  formatWakeAt,
} from '../lib/snoozePresets.js';
import { vi } from 'vitest';

// Thu 15 Oct 2026, 16:05 local.
const NOW = new Date(2026, 9, 15, 16, 5).getTime();

describe('formatWakeAt', () => {
  it('is HH:MM for today, 24-hour', () => {
    expect(formatWakeAt(new Date(2026, 9, 15, 17, 0).getTime(), NOW)).toBe('17:00');
    expect(formatWakeAt(new Date(2026, 9, 15, 0, 7).getTime(), NOW)).toBe('00:07');
  });
  it('is weekday + time within the next 6 days', () => {
    expect(formatWakeAt(new Date(2026, 9, 16, 8, 0).getTime(), NOW)).toBe('Fri 08:00');
    expect(formatWakeAt(new Date(2026, 9, 21, 23, 30).getTime(), NOW)).toBe('Wed 23:30');
  });
  it('is weekday, day and month beyond that', () => {
    expect(formatWakeAt(new Date(2026, 9, 22, 8, 0).getTime(), NOW)).toBe('Thu 22 Oct');
    expect(formatWakeAt(new Date(2026, 10, 3, 8, 0).getTime(), NOW)).toBe('Tue 3 Nov');
  });
  it('treats midnight crossing as tomorrow, not today', () => {
    expect(formatWakeAt(new Date(2026, 9, 16, 0, 1).getTime(), NOW)).toBe('Fri 00:01');
  });
});

describe('each preset resolves to the wording the sheet shows', () => {
  it('on a Thursday afternoon', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const shown = Object.fromEntries(
        SNOOZE_PRESETS.map((p) => [p.id, formatWakeAt(p.resolve(), NOW)]),
      );
      expect(shown).toEqual({
        '2-minutes': '16:07',
        '5-minutes': '16:10',
        '30-minutes': '16:35',
        '1-hour': '17:05',
        '5pm': '17:00',
        'tomorrow-8am': 'Fri 08:00',
        '1-day': 'Fri 16:05',
        'next-monday': 'Mon 08:00',
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it('after 5pm, "5pm" is tomorrow', () => {
    vi.useFakeTimers();
    const late = new Date(2026, 9, 15, 18, 0).getTime();
    vi.setSystemTime(late);
    try {
      const p = SNOOZE_PRESETS.find((x) => x.id === '5pm')!;
      expect(formatWakeAt(p.resolve(), late)).toBe('Fri 17:00');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('formatElapsed', () => {
  it('minutes then hours and minutes', () => {
    expect(formatElapsed(25 * 60_000)).toBe('25m');
    expect(formatElapsed(130 * 60_000)).toBe('2h 10m');
    expect(formatElapsed(120 * 60_000)).toBe('2h');
    expect(formatElapsed(-5)).toBe('0m');
  });
});

describe('formatSnoozeMoment', () => {
  const wake = new Date(2026, 9, 15, 8, 0).getTime();
  it('puts a weekday before a time that is not on the wake day', () => {
    expect(formatSnoozeMoment(new Date(2026, 9, 14, 19, 42).getTime(), wake)).toBe('Wed 19:42');
    expect(formatSnoozeMoment(new Date(2026, 9, 15, 3, 52).getTime(), wake)).toBe('03:52');
  });
});
