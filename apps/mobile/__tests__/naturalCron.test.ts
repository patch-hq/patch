// lib/naturalCron.ts — English ⇄ cron for the New-job schedule field (ported
// verbatim from packages/web). Exercises every parse shape (interval /
// hourly / time-of-day / weekday-weekend / named-day / windowed) and every
// describeCron rendering branch, plus the "can't confidently parse" nulls.

import { describe, it, expect } from 'vitest';
import { describeCron as wireDescribeCron } from '@patch/wire';
import { parseNaturalSchedule, describeCron } from '../src/lib/naturalCron';

describe('parseNaturalSchedule', () => {
  it('returns null for an empty/blank string', () => {
    expect(parseNaturalSchedule('')).toBeNull();
    expect(parseNaturalSchedule('   ')).toBeNull();
  });

  it('reads a leading time ("8am every day", "17:30 weekdays")', () => {
    expect(parseNaturalSchedule('8am every day')).toBe('0 8 * * *');
    expect(parseNaturalSchedule('17:30 weekdays')).toBe('30 17 * * 1-5');
  });
  it('refuses a time window cron cannot express instead of reading its end time as the schedule', () => {
    expect(parseNaturalSchedule('every day between 9am and 5pm')).toBeNull();
    expect(parseNaturalSchedule('every day from 5pm to 9am')).toBeNull();
  });

  it('reads a dotted clock time ("7.30pm")', () => {
    expect(parseNaturalSchedule('every weekday at 7.30pm')).toBe('30 19 * * 1-5');
  });

  it('refuses a day phrase with digits that are not a time, never a silent midnight', () => {
    expect(parseNaturalSchedule('9 every day')).toBeNull();
  });

  it('parses "every 15 minutes"', () => {
    expect(parseNaturalSchedule('every 15 minutes')).toBe('*/15 * * * *');
  });
  it('parses "every 1 min" (singular unit form)', () => {
    expect(parseNaturalSchedule('every 1 min')).toBe('*/1 * * * *');
  });
  it('rejects an out-of-range minute interval (falls through to null)', () => {
    expect(parseNaturalSchedule('every 90 minutes')).toBeNull();
  });
  it('parses "every minute"', () => {
    expect(parseNaturalSchedule('every minute')).toBe('* * * * *');
  });

  it('parses "every 2 hours"', () => {
    expect(parseNaturalSchedule('every 2 hours')).toBe('0 */2 * * *');
  });
  it('rejects an out-of-range hour interval', () => {
    expect(parseNaturalSchedule('every 30 hours')).toBeNull();
  });
  it('parses "hourly"', () => {
    expect(parseNaturalSchedule('hourly')).toBe('0 * * * *');
  });
  it('parses "every hour"', () => {
    expect(parseNaturalSchedule('every hour')).toBe('0 * * * *');
  });

  it('parses "every day at 9am"', () => {
    expect(parseNaturalSchedule('every day at 9am')).toBe('0 9 * * *');
  });
  it('parses "daily at 09:00"', () => {
    expect(parseNaturalSchedule('daily at 09:00')).toBe('0 9 * * *');
  });
  it('parses "at 9am" (bare "at", no day phrase)', () => {
    expect(parseNaturalSchedule('at 9am')).toBe('0 9 * * *');
  });
  it('parses a trailing time with no "at" ("9am" at the end)', () => {
    expect(parseNaturalSchedule('every day 5pm')).toBe('0 17 * * *');
  });
  it('parses "noon" and "midnight"', () => {
    expect(parseNaturalSchedule('every day at noon')).toBe('0 12 * * *');
    expect(parseNaturalSchedule('every day at midnight')).toBe('0 0 * * *');
  });

  it('parses several times sharing a minute into a comma hour field', () => {
    expect(parseNaturalSchedule('every day at 9am and 10pm')).toBe('0 9,22 * * *');
    expect(parseNaturalSchedule('at 9am, 1pm and 10pm')).toBe('0 9,13,22 * * *');
    expect(parseNaturalSchedule('every weekday at 8:30am and 5:30pm')).toBe('30 8,17 * * 1-5');
  });

  it('returns null when listed times do not share a minute', () => {
    expect(parseNaturalSchedule('every day at 9am and 10:30pm')).toBeNull();
  });

  it('returns null when a second time is phrased outside the "at" list, rather than dropping it', () => {
    expect(parseNaturalSchedule('every day at 9am and at 5pm')).toBeNull();
    expect(parseNaturalSchedule('8am and 5pm every day')).toBeNull();
    expect(parseNaturalSchedule('every monday at 8:30 and tuesday at 9')).toBeNull();
  });

  it('returns null for an exclusion or alternative it cannot express, rather than ignoring the word', () => {
    // "except weekends" used to come out as `0 9-17 * * 0,6` — the opposite schedule.
    expect(parseNaturalSchedule('every hour between 9am and 5pm except weekends')).toBeNull();
    expect(parseNaturalSchedule('every day at 9am or 10pm')).toBeNull();
  });

  it('renders a multi-time schedule in the live preview', () => {
    expect(describeCron(parseNaturalSchedule('every day at 9am and 10pm')!)).toBe(
      'at 9am and 10pm',
    );
  });

  it('parses "every weekday at 9am"', () => {
    expect(parseNaturalSchedule('every weekday at 9am')).toBe('0 9 * * 1-5');
  });
  it('parses "weekdays at 8:30"', () => {
    expect(parseNaturalSchedule('weekdays at 8:30')).toBe('30 8 * * 1-5');
  });
  it('parses "every weekend at 10am"', () => {
    expect(parseNaturalSchedule('every weekend at 10am')).toBe('0 10 * * 0,6');
  });
  it('a day phrase with no time defaults to midnight', () => {
    expect(parseNaturalSchedule('every weekday')).toBe('0 0 * * 1-5');
  });

  it('parses a single named day ("mondays at 8")', () => {
    expect(parseNaturalSchedule('mondays at 8')).toBe('0 8 * * 1');
  });
  it('parses two named days ("monday and thursday at 9am")', () => {
    expect(parseNaturalSchedule('monday and thursday at 9am')).toBe('0 9 * * 1,4');
  });
  it('de-dupes + sorts repeated day names', () => {
    expect(parseNaturalSchedule('mon, wed, mon at 9am')).toBe('0 9 * * 1,3');
  });
  it('recognises every day-name abbreviation', () => {
    expect(parseNaturalSchedule('tues at 9am')).toBe('0 9 * * 2');
    expect(parseNaturalSchedule('thurs at 9am')).toBe('0 9 * * 4');
    expect(parseNaturalSchedule('sat at 9am')).toBe('0 9 * * 6');
    expect(parseNaturalSchedule('sun at 9am')).toBe('0 9 * * 0');
  });

  it('refuses a window whose ends fall between the hours — cron cannot start at 9:30', () => {
    // Cron's hour field would fire at 9:00 and 9:15 (before the window opens)
    // and 17:45 (after it closes).
    expect(parseNaturalSchedule('every 15 minutes between 9:30am and 5:30pm')).toBeNull();
    expect(parseNaturalSchedule('every 2 hours from 9:30am to 5pm')).toBeNull();
    expect(parseNaturalSchedule('every 5 minutes between 9am and 9:30am')).toBeNull();
  });

  it('a window on the hour is still read', () => {
    expect(parseNaturalSchedule('every 15 minutes between 9:00am and 5:00pm')).toBe(
      '*/15 9-17 * * *',
    );
  });

  it('a range of days that covers the whole week is every day, not an empty field', () => {
    expect(parseNaturalSchedule('monday to sunday at 9am')).toBe('0 9 * * *');
    expect(parseNaturalSchedule('tuesday to monday at 9am')).toBe('0 9 * * *');
    expect(parseNaturalSchedule('every 5 minutes monday to sunday')).toBe('*/5 * * * *');
  });

  it('a range that wraps the weekend still lists its days', () => {
    expect(parseNaturalSchedule('friday to monday at 9am')).toBe('0 9 * * 0,1,5,6');
  });

  it('parses a time window ("between 9am and 5pm") combined with an interval', () => {
    expect(parseNaturalSchedule('every 5 minutes between 9am and 5pm')).toBe('*/5 9-17 * * *');
  });
  it('parses "from X to Y" as an equivalent window phrasing', () => {
    expect(parseNaturalSchedule('every 10 minutes from 9 to 17')).toBe('*/10 9-17 * * *');
  });
  it('parses a windowed hourly step ("every 2 hours between 9am and 5pm")', () => {
    expect(parseNaturalSchedule('every 2 hours between 9am and 5pm')).toBe('0 9-17/2 * * *');
  });
  it('a window combined with weekdays constrains both hour and day fields', () => {
    expect(parseNaturalSchedule('every 15 minutes between 9am and 5pm on weekdays')).toBe(
      '*/15 9-17 * * 1-5',
    );
  });
  it('a window that wraps past midnight (start > end) is refused, never widened to all day', () => {
    expect(parseNaturalSchedule('every 5 minutes between 5pm and 9am')).toBeNull();
  });

  it('returns null for unparseable gibberish', () => {
    expect(parseNaturalSchedule('do the thing whenever')).toBeNull();
  });

  it('a window with a token that fails to match the window shape at all is dropped, not fatal', () => {
    // "12 34am" isn't even a well-formed TIME_TOKEN once you account for the
    // trailing "and 5pm" the outer window regex still needs — parseTimeWindow
    // itself fails to match, well before ever calling parseTime.
    expect(parseNaturalSchedule('every 5 minutes between 12 34am and 5pm')).toBe('*/5 * * * *');
  });

  it('a window whose start hour is out of range is refused, never widened to all day', () => {
    // "25:00" matches TIME_TOKEN's shape (the window regex succeeds), but parseTime
    // rejects it on range (h>23).
    expect(parseNaturalSchedule('every 5 minutes between 25:00 and 5pm')).toBeNull();
  });

  it('an "at <time>" phrase whose captured text is syntactically invalid is refused, not read as midnight', () => {
    // atMatch's charset ([0-9: ]+) is looser than parseTime's own anchored
    // regex — "12:34:56am" (two colons) matches atMatch but parseTime's
    // single optional `:mm` group can't consume it, so parseTime's `m` is
    // null and it returns null via its own regex-mismatch branch (distinct
    // from the out-of-range h>23/min>59 branch pinned above).
    // The digits are there but are not a time, so the web parser returns null
    // rather than a silent midnight; mobile must agree.
    expect(parseNaturalSchedule('every day at 12:34:56am')).toBeNull();
  });

  it('a bare clock time with no day phrase and no "at"/day-word context returns null', () => {
    // No day phrase (so parseDow is null) and none of atMatch / "every day"|
    // "daily" / a leading "at " hold — the trailing-time branch's guard is
    // false even though a time WAS extracted.
    expect(parseNaturalSchedule('5pm')).toBeNull();
  });

  it('a day phrase with an unparseable clock time returns null rather than guessing midnight', () => {
    expect(parseNaturalSchedule('every day at 25:00')).toBeNull();
    expect(parseNaturalSchedule('every day at 9:99')).toBeNull();
  });

  it('12am/12pm boundary: 12am is midnight, 12pm is noon', () => {
    expect(parseNaturalSchedule('every day at 12am')).toBe('0 0 * * *');
    expect(parseNaturalSchedule('every day at 12pm')).toBe('0 12 * * *');
  });
});

// describeCron is no longer ported into this file — `src/lib/naturalCron.ts`
// re-exports the one describer from @patch/wire (exhaustive phrasing table in
// packages/wire/test/cron-describe.test.ts). These cases stay as mobile's own
// proof that the re-export is wired up and renders the shapes its job list and
// editor actually show.
describe('describeCron', () => {
  it('is the shared describer from @patch/wire, not a local port', () => {
    expect(describeCron).toBe(wireDescribeCron);
  });

  it('returns "" for a non-5-field expression', () => {
    expect(describeCron('* * *')).toBe('');
  });

  it('describes a plain minute interval', () => {
    expect(describeCron('*/5 * * * *')).toBe('every 5 minutes');
    expect(describeCron('*/1 * * * *')).toBe('every 1 minute'); // singular
  });
  it('describes "every minute"', () => {
    expect(describeCron('* * * * *')).toBe('every minute');
  });
  it('describes a plain hour interval', () => {
    expect(describeCron('0 */3 * * *')).toBe('every 3 hours');
    expect(describeCron('0 */1 * * *')).toBe('every 1 hour');
  });
  it('describes "every hour"', () => {
    expect(describeCron('0 * * * *')).toBe('every hour');
  });

  it('describes a windowed minute interval', () => {
    expect(describeCron('*/5 9-17 * * *')).toBe('every 5 minutes between 9am and 5pm');
  });
  it('describes a windowed "every minute"', () => {
    expect(describeCron('* 9-17 * * *')).toBe('every minute between 9am and 5pm');
  });
  it('describes a windowed hourly step', () => {
    expect(describeCron('0 9-17/2 * * *')).toBe('every 2 hours between 9am and 5pm');
    expect(describeCron('0 9-17/1 * * *')).toBe('every 1 hour between 9am and 5pm');
  });
  it('describes a plain windowed hour (no step — "every hour")', () => {
    expect(describeCron('0 9-17 * * *')).toBe('every hour between 9am and 5pm');
  });
  it('a windowed range with dom/mon not both "*" is not treated as a window', () => {
    expect(describeCron('0 9-17 1 * *')).toBe('');
  });
  it('fmtHour formats a window boundary at midnight/noon (not just a plain hour)', () => {
    expect(describeCron('*/5 0-12 * * *')).toBe('every 5 minutes between midnight and noon');
  });

  it('appends a weekday/weekend/day-list suffix to an interval phrase', () => {
    expect(describeCron('*/5 * * * 1-5')).toBe('every 5 minutes on weekdays');
    expect(describeCron('*/5 * * * 0,6')).toBe('every 5 minutes on weekends');
    expect(describeCron('*/5 * * * 6,0')).toBe('every 5 minutes on weekends');
    expect(describeCron('*/5 * * * 1,4')).toBe('every 5 minutes on Monday, Thursday');
  });
  it('an interval with an out-of-range day index (hand-typed cron) is refused outright', () => {
    // Reachable via manually-typed cron text (the job editor's raw-cron
    // field), not just parseNaturalSchedule output. The old describer dropped
    // the unreadable day silently and still returned a confident phrase.
    expect(describeCron('*/5 * * * 8')).toBe('');
  });

  it('describes a fixed time-of-day, every day', () => {
    expect(describeCron('0 9 * * *')).toBe('every day at 9am');
    expect(describeCron('30 17 * * *')).toBe('every day at 5:30pm');
  });
  it('describes a fixed time-of-day on weekdays/weekends', () => {
    expect(describeCron('0 9 * * 1-5')).toBe('weekdays at 9am');
    expect(describeCron('0 9 * * 0,6')).toBe('weekends at 9am');
  });
  it('describes a fixed time-of-day on named days', () => {
    expect(describeCron('0 9 * * 1')).toBe('Mondays at 9am');
    expect(describeCron('0 9 * * 1,4')).toBe('Monday, Thursday at 9am');
  });
  it('a fixed time-of-day with an out-of-range day index (hand-typed cron) yields ""', () => {
    expect(describeCron('0 9 * * 8')).toBe('');
  });
  it('midnight/noon format correctly in the 12-hour clock', () => {
    expect(describeCron('0 0 * * *')).toBe('every day at 12am');
    expect(describeCron('0 12 * * *')).toBe('every day at 12pm');
  });

  it('returns "" for a shape describeCron does not recognise', () => {
    expect(describeCron('5 5 5 5 5')).toBe('');
  });
});

describe('parseNaturalSchedule — what it cannot say it refuses to say', () => {
  it.each([
    'every 2 days at 9am',
    'every other day at 9am',
    'every week at 9am',
    'every month at 9am',
    'monthly at 9am',
    'every 2 weeks on monday at 9am',
  ])('%s is not a daily schedule', (phrase) => {
    expect(parseNaturalSchedule(phrase)).toBeNull();
  });

  it.each([
    ['monday to friday at 9am', '0 9 * * 1-5'],
    ['mon-fri at 8:30am', '30 8 * * 1-5'],
    ['tuesday through thursday at 9am', '0 9 * * 2-4'],
  ])('%s is a day range', (phrase, cron) => {
    expect(parseNaturalSchedule(phrase)).toBe(cron);
  });

  it('keeps a compact time window rather than dropping it', () => {
    expect(parseNaturalSchedule('every 15 minutes 9am-5pm')).toBe('*/15 9-17 * * *');
  });
});
