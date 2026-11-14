import { describe, it, expect } from 'vitest';
import {
  backRecord,
  backSetToClear,
  deriveSnoozeOutcome,
  formatSnoozeDuration,
  openSnoozeRecord,
  SNOOZE_UNTIL_COMPLETE,
  formatWakeAt,
  snoozeDividerText,
  SNOOZE_SLIDER_HOURS,
  snoozeSliderLabel,
  type SnoozeRecord,
} from '../src/index.js';

const rec = (over: Partial<SnoozeRecord> = {}): SnoozeRecord => ({
  setId: 's1',
  startedAt: 1_000,
  startSeq: 3,
  until: 9_000,
  endedAt: 9_000,
  outcome: { kind: 'none' },
  backCleared: false,
  ...over,
});

const base = { activity: 'idle', askingQuestion: false, now: 50 } as const;

describe('deriveSnoozeOutcome', () => {
  it('did nothing → none', () => {
    expect(deriveSnoozeOutcome({ ...base })).toEqual({ kind: 'none' });
  });
  it('finished a turn → finished at that time', () => {
    expect(deriveSnoozeOutcome({ ...base, finishedAt: 20 })).toEqual({ kind: 'finished', at: 20 });
  });
  it('still running at wake → running, even if it finished a turn earlier', () => {
    expect(deriveSnoozeOutcome({ ...base, activity: 'running', finishedAt: 20 })).toEqual({
      kind: 'running',
    });
  });
  it('blocked on a permission or question → waiting since it began', () => {
    expect(
      deriveSnoozeOutcome({ ...base, activity: 'awaiting-permission', waitingSince: 11 }),
    ).toEqual({ kind: 'waiting', at: 11 });
    expect(deriveSnoozeOutcome({ ...base, askingQuestion: true, waitingSince: 12 })).toEqual({
      kind: 'waiting',
      at: 12,
    });
  });
  it('errored → errored at the error time; waiting outranks it', () => {
    expect(deriveSnoozeOutcome({ ...base, activity: 'errored', erroredAt: 30 })).toEqual({
      kind: 'errored',
      at: 30,
    });
    expect(
      deriveSnoozeOutcome({ ...base, activity: 'awaiting-permission', erroredAt: 30 }).kind,
    ).toBe('waiting');
  });
  it('falls back to the wake time when the moment was not tracked', () => {
    expect(deriveSnoozeOutcome({ ...base, activity: 'errored' })).toEqual({
      kind: 'errored',
      at: 50,
    });
  });
});

describe('snooze record lookups', () => {
  it('openSnoozeRecord is the last record while it has not ended', () => {
    expect(openSnoozeRecord([rec({ endedAt: null })])?.setId).toBe('s1');
    expect(openSnoozeRecord([rec()])).toBeNull();
    expect(openSnoozeRecord(undefined)).toBeNull();
  });
  it('backRecord is an ended record that has not been cleared', () => {
    expect(backRecord([rec()])).not.toBeNull();
    expect(backRecord([rec({ backCleared: true })])).toBeNull();
    expect(backRecord([rec({ endedAt: null })])).toBeNull();
  });
});

describe('backSetToClear', () => {
  const chats = [
    { chatId: 'a', snoozeRecords: [rec({ setId: 's1' })] },
    { chatId: 'b', snoozeRecords: [rec({ setId: 's1' })] },
    { chatId: 'c', snoozeRecords: [rec({ setId: 's2' })] },
    { chatId: 'd', snoozeRecords: [rec({ setId: 's1', backCleared: true })] },
    { chatId: 'e', snoozeRecords: [] },
  ];
  it('is every chat still showing Back for the same set', () => {
    expect(backSetToClear(chats, 'a').sort()).toEqual(['a', 'b']);
    expect(backSetToClear(chats, 'b').sort()).toEqual(['a', 'b']);
  });
  it('is empty for a chat with no Back state', () => {
    expect(backSetToClear(chats, 'd')).toEqual([]);
    expect(backSetToClear(chats, 'e')).toEqual([]);
    expect(backSetToClear(chats, 'nope')).toEqual([]);
  });
});

describe('formatSnoozeDuration', () => {
  it('minutes, hours, days', () => {
    expect(formatSnoozeDuration(45 * 60_000)).toBe('45m');
    expect(formatSnoozeDuration(12 * 3_600_000)).toBe('12h');
    expect(formatSnoozeDuration(3 * 86_400_000)).toBe('3d');
    expect(formatSnoozeDuration(1000)).toBe('1m');
  });
});

describe('until complete', () => {
  it('reads as "when done" and the open divider says until complete', () => {
    expect(formatWakeAt(SNOOZE_UNTIL_COMPLETE)).toBe('when done');
    expect(formatWakeAt(SNOOZE_UNTIL_COMPLETE, Date.now(), true)).toBe('goal is met');
    const open = rec({ until: SNOOZE_UNTIL_COMPLETE, endedAt: null, startedAt: 1_700_000_000_000 });
    expect(snoozeDividerText(open)).toMatch(/^Snoozed \d\d:\d\d – until complete$/);
  });
  it('a same-minute snooze that errored reads as a failed, retried turn', () => {
    const t = new Date(2026, 10, 11, 12, 24, 5).getTime();
    const r = rec({
      startedAt: t,
      endedAt: t + 2_000,
      until: t + 2_000,
      outcome: { kind: 'errored', at: t + 1_000 },
    });
    expect(snoozeDividerText(r)).toBe('Turn failed at 12:24 and was retried');
  });
});

describe('snooze slider stops', () => {
  it('are ascending and labelled in hours, days and weeks', () => {
    expect([...SNOOZE_SLIDER_HOURS]).toEqual([...SNOOZE_SLIDER_HOURS].sort((a, b) => a - b));
    expect(SNOOZE_SLIDER_HOURS.map(snoozeSliderLabel)).toEqual([
      '1 hour',
      '2 hours',
      '3 hours',
      '4 hours',
      '6 hours',
      '8 hours',
      '12 hours',
      '1 day',
      '2 days',
      '3 days',
      '1 week',
    ]);
  });
});
