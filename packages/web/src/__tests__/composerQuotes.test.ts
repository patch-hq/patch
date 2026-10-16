import { describe, expect, it } from 'vitest';
import { joinQuotes, splitQuotes } from '../lib/composerQuotes.js';

describe('splitQuotes', () => {
  it('has no quotes in plain text', () => {
    expect(splitQuotes('hello\n> not leading')).toEqual({
      quotes: [],
      body: 'hello\n> not leading',
    });
  });
  it('lifts leading quote blocks, multi-line included', () => {
    expect(splitQuotes('> a\n> b\n\n> c\n\nwhy?')).toEqual({ quotes: ['a\nb', 'c'], body: 'why?' });
  });
  it('treats a quote with nothing after it as an empty body', () => {
    expect(splitQuotes('> a\n\n')).toEqual({ quotes: ['a'], body: '' });
  });
  it('round-trips, keeping extra leading newlines in the body', () => {
    const body = '\n\ntyped  ';
    expect(splitQuotes(joinQuotes(['x', 'y\nz'], body))).toEqual({ quotes: ['x', 'y\nz'], body });
  });
});
