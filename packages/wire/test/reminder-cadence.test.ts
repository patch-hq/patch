import { describe, it, expect } from 'vitest';
import { parseReminderArg, describeReminderEvery } from '../src/index.js';

describe('parseReminderArg', () => {
  it('plain text is a banner-only reminder', () => {
    expect(parseReminderArg('call mum')).toEqual({ reminder: 'call mum', every: null });
    expect(parseReminderArg('everyone check')).toEqual({ reminder: 'everyone check', every: null });
  });
  it('empty clears', () => {
    expect(parseReminderArg(null)).toEqual({ reminder: null, every: null });
    expect(parseReminderArg('  ')).toEqual({ reminder: null, every: null });
  });
  it('turn cadences', () => {
    expect(parseReminderArg('every 10 turns The principles')).toEqual({
      reminder: 'The principles',
      every: { unit: 'turns', n: 10 },
    });
    expect(parseReminderArg('EVERY 1 turn x').every).toEqual({ unit: 'turns', n: 1 });
  });
  it('time cadences, hours become minutes', () => {
    expect(parseReminderArg('every 30m x').every).toEqual({ unit: 'minutes', n: 30 });
    expect(parseReminderArg('every 15 min x').every).toEqual({ unit: 'minutes', n: 15 });
    expect(parseReminderArg('every 2 hours x').every).toEqual({ unit: 'minutes', n: 120 });
  });
  it('rejects zero, no text, and absurd values', () => {
    expect(() => parseReminderArg('every 0 turns x')).toThrow(/at least 1/);
    expect(() => parseReminderArg('every 5 turns')).toThrow(/needs text/);
    expect(() => parseReminderArg('every 99999 min x')).toThrow(/too large/);
  });
  it('describes a cadence', () => {
    expect(describeReminderEvery({ unit: 'turns', n: 1 })).toBe('every 1 turn');
    expect(describeReminderEvery({ unit: 'turns', n: 10 })).toBe('every 10 turns');
    expect(describeReminderEvery({ unit: 'minutes', n: 45 })).toBe('every 45 min');
    expect(describeReminderEvery({ unit: 'minutes', n: 120 })).toBe('every 2 h');
  });
});
