import { describe, expect, it } from 'vitest';
import { SpeakerLog } from '../lib/speakerLog.js';

describe('SpeakerLog', () => {
  it('names nobody before anything is reported', () => {
    expect(new SpeakerLog().dominant(0, 1000)).toBeUndefined();
  });

  it('picks whoever was lit up longest within the window', () => {
    const log = new SpeakerLog();
    log.record(['Dev'], 0);
    log.record(['Priya'], 2000);
    log.record([], 9000);
    expect(log.dominant(0, 10_000)).toBe('Priya');
    expect(log.dominant(0, 3000)).toBe('Dev');
    expect(log.dominant(9500, 10_000)).toBeUndefined();
  });

  it('carries the last state into a later window', () => {
    const log = new SpeakerLog();
    log.record(['Dev'], 1000);
    expect(log.dominant(5000, 6000)).toBe('Dev');
  });

  it('shares time equally when two are lit', () => {
    const log = new SpeakerLog();
    log.record(['Dev', 'Priya'], 0);
    log.record(['Priya'], 4000);
    expect(log.dominant(0, 8000)).toBe('Priya');
  });
});
