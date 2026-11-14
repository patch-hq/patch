import { describe, expect, it } from 'vitest';
import { activeBangToken, filterJobs, removeBangToken } from '../lib/jobToken.js';

describe('activeBangToken', () => {
  it('opens at the start of the message and after whitespace', () => {
    expect(activeBangToken('!', 1)).toEqual({ start: 0, query: '' });
    expect(activeBangToken('run !tim', 8)).toEqual({ start: 4, query: 'tim' });
    expect(activeBangToken('a\n!x', 4)).toEqual({ start: 2, query: 'x' });
  });
  it('does not open mid-word, once closed, or for a slash', () => {
    expect(activeBangToken('wow!', 4)).toBeNull();
    expect(activeBangToken('!job ', 5)).toBeNull();
    expect(activeBangToken('/job', 4)).toBeNull();
  });
});

describe('removeBangToken', () => {
  it('removes the token and one surrounding space', () => {
    const t = activeBangToken('run !job now', 8)!;
    expect(removeBangToken('run !job now', t, 8)).toEqual({ text: 'run now', cursor: 4 });
  });
  it('leaves an empty draft when it was the whole message', () => {
    const t = activeBangToken('!job', 4)!;
    expect(removeBangToken('!job', t, 4)).toEqual({ text: '', cursor: 0 });
  });
});

describe('filterJobs', () => {
  const jobs = [
    { id: 'a', name: 'Daily timesheet' },
    { id: 'b', name: 'Weekly timesheet' },
    { id: 'c', name: 'Backup' },
  ];
  it('ranks prefix, then substring, then letters in order', () => {
    expect(filterJobs(jobs, '').map((j) => j.id)).toEqual(['a', 'b', 'c']);
    expect(filterJobs(jobs, 'week').map((j) => j.id)).toEqual(['b']);
    expect(filterJobs(jobs, 'time').map((j) => j.id)).toEqual(['a', 'b']);
    expect(filterJobs(jobs, 'bkp').map((j) => j.id)).toEqual(['c']);
    expect(filterJobs(jobs, 'zzz')).toEqual([]);
  });
});
