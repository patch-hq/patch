// Snooze preset wake times (spec/04 § Snooze) at the edges where a wall-clock
// calculation can land early: the UK clock changes, the minute a preset is
// chosen on its own boundary, and week/month rollovers. A preset must always
// resolve strictly after "now" and to the wall-clock time its label names.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SNOOZE_PRESETS, distinctPresets } from '../lib/snoozePresets.js';

const preset = (id: string) => SNOOZE_PRESETS.find((p) => p.id === id)!;
const local = (y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0) =>
  new Date(y, m - 1, d, h, min, s, ms).getTime();
const at = (now: number, id: string): Date => {
  vi.setSystemTime(now);
  return new Date(preset(id).resolve());
};

let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'Europe/London';
  vi.useFakeTimers();
});
afterEach(() => vi.setSystemTime(0));
afterAll(() => {
  vi.useRealTimers();
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('snooze presets across the UK clock changes', () => {
  it('runs in Europe/London so the transitions below are real', () => {
    expect(new Date(2026, 9, 25, 12).getTimezoneOffset()).toBe(0);
    expect(new Date(2026, 5, 1, 12).getTimezoneOffset()).toBe(-60);
  });

  it('5pm chosen the evening before clocks go back is 17:00 local the next day', () => {
    const r = at(local(2026, 10, 24, 23, 30), '5pm');
    expect([r.getDate(), r.getHours(), r.getMinutes()]).toEqual([25, 17, 0]);
  });

  it('Tomorrow 8am across clocks going back is 08:00 local, 25 hours away', () => {
    const now = local(2026, 10, 24, 20, 0);
    const r = at(now, 'tomorrow-8am');
    expect([r.getDate(), r.getHours()]).toEqual([25, 8]);
    expect(r.getTime() - now).toBe(13 * 3_600_000);
  });

  it('Tomorrow 8am across clocks going forward is 08:00 local, not 07:00 or 09:00', () => {
    const r = at(local(2026, 3, 28, 20, 0), 'tomorrow-8am');
    expect([r.getDate(), r.getHours()]).toEqual([29, 8]);
  });

  it('Next Monday across clocks going forward is Monday 08:00 local', () => {
    const r = at(local(2026, 3, 27, 12, 0), 'next-monday');
    expect([r.getMonth(), r.getDate(), r.getDay(), r.getHours()]).toEqual([2, 30, 1, 8]);
  });

  it('1 day is exactly 24 hours, even over a clock change', () => {
    const now = local(2026, 10, 24, 12, 0);
    expect(at(now, '1-day').getTime() - now).toBe(24 * 3_600_000);
  });
});

describe('snooze presets on their own boundary', () => {
  it('5pm chosen at exactly 17:00:00.000 is tomorrow, not now', () => {
    const now = local(2026, 10, 15, 17, 0);
    const r = at(now, '5pm');
    expect(r.getTime()).toBeGreaterThan(now);
    expect([r.getDate(), r.getHours()]).toEqual([16, 17]);
  });

  it('5pm chosen one millisecond before 17:00 is today', () => {
    const now = local(2026, 10, 15, 16, 59, 59, 999);
    const r = at(now, '5pm');
    expect([r.getDate(), r.getHours()]).toEqual([15, 17]);
  });

  it('Tomorrow 8am chosen just after midnight is the coming 08:00, a day on', () => {
    const r = at(local(2026, 10, 15, 0, 0, 1), 'tomorrow-8am');
    expect([r.getDate(), r.getHours()]).toEqual([16, 8]);
  });

  it.each([
    ['Mon 26 Oct', local(2026, 10, 26, 7, 0), 2],
    ['Sun 25 Oct', local(2026, 10, 25, 23, 59), 26],
    ['Sat 24 Oct', local(2026, 10, 24, 9, 0), 26],
    ['Fri 30 Oct (month rollover)', local(2026, 10, 30, 9, 0), 2],
  ])('Next Monday from %s lands on a Monday at 08:00, in the future', (_name, now, day) => {
    const r = at(now, 'next-monday');
    expect(r.getDay()).toBe(1);
    expect(r.getHours()).toBe(8);
    expect(r.getDate()).toBe(day);
    expect(r.getTime()).toBeGreaterThan(now);
  });
});

describe('every preset resolves strictly after now', () => {
  // Sampled hourly-ish across both 2026 UK changes and a year end.
  const edges = [local(2026, 3, 29), local(2026, 10, 25), local(2026, 12, 31, 23)];
  const instants = edges.flatMap((e) =>
    Array.from({ length: 96 }, (_, i) => e - 24 * 3_600_000 + i * 1_800_000 + 17),
  );
  it.each(SNOOZE_PRESETS.map((p) => p.id))('%s', (id) => {
    for (const now of instants) {
      vi.setSystemTime(now);
      expect(preset(id).resolve(), new Date(now).toString()).toBeGreaterThan(now);
    }
  });
});

describe('distinctPresets', () => {
  const ids = (now: number) => {
    vi.setSystemTime(now);
    return distinctPresets(SNOOZE_PRESETS).map((p) => p.id);
  };
  it('drops Next Monday on a Sunday, when it is Tomorrow 8am', () => {
    expect(ids(local(2026, 10, 25, 10))).not.toContain('next-monday');
    expect(ids(local(2026, 10, 25, 10))).toContain('tomorrow-8am');
  });
  it('keeps every preset on an ordinary Wednesday morning', () => {
    expect(ids(local(2026, 10, 21, 9))).toEqual(SNOOZE_PRESETS.map((p) => p.id));
  });
  it('drops 1 day when it lands on Tomorrow 8am', () => {
    expect(ids(local(2026, 10, 21, 8))).not.toContain('1-day');
  });
});
