import { describe, it, expect } from 'vitest';
import { parseJobCommand, matchJob } from '../lib/jobCommand.js';

const jobs = [
  { id: 'a1', name: 'Morning brief' },
  { id: 'b2', name: 'Morning news' },
  { id: 'c3', name: 'Backup' },
];

describe('parseJobCommand', () => {
  it('parses name', () => {
    expect(parseJobCommand(' /Job Backup ')).toEqual({ isJob: true, query: 'Backup' });
  });
  it('bare /job has null query', () => {
    expect(parseJobCommand('/job')).toEqual({ isJob: true, query: null });
  });
  it('ignores other messages', () => {
    expect(parseJobCommand('/jobs')).toEqual({ isJob: false, query: null });
    expect(parseJobCommand('hi /job x')).toEqual({ isJob: false, query: null });
  });
});

describe('matchJob', () => {
  it('exact name, case-insensitive', () => {
    expect(matchJob(jobs, 'backup')).toEqual({ kind: 'one', id: 'c3' });
  });
  it('exact id', () => {
    expect(matchJob(jobs, 'b2')).toEqual({ kind: 'one', id: 'b2' });
  });
  it('unique prefix', () => {
    expect(matchJob(jobs, 'morning b')).toEqual({ kind: 'one', id: 'a1' });
  });
  it('ambiguous', () => {
    expect(matchJob(jobs, 'morning')).toEqual({
      kind: 'many',
      names: ['Morning brief', 'Morning news'],
    });
  });
  it('none', () => {
    expect(matchJob(jobs, 'zzz')).toEqual({ kind: 'none' });
  });
});
