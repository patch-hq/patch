import { describe, expect, it } from 'vitest';
import { joinThread, splitThread } from '../lib/composerQuotes.js';

const q = (text: string) => ({ kind: 'quote' as const, text });
const r = (text: string) => ({ kind: 'reply' as const, text });

describe('splitThread', () => {
  it('has no quotes in plain text', () => {
    expect(splitThread('hello\n> not leading')).toEqual({
      thread: [],
      body: 'hello\n> not leading',
    });
  });
  it('lifts leading quote blocks, multi-line included', () => {
    expect(splitThread('> a\n> b\n\n> c\n\nwhy?')).toEqual({
      thread: [q('a\nb'), q('c')],
      body: 'why?',
    });
  });
  it('treats a quote with nothing after it as an empty body', () => {
    expect(splitThread('> a\n\n')).toEqual({ thread: [q('a')], body: '' });
    expect(splitThread('> a')).toEqual({ thread: [q('a')], body: '' });
  });
  it('keeps the reply under each quote, then the next quote', () => {
    expect(splitThread('> a\n\nabout a\n\n> b\n\nabout b')).toEqual({
      thread: [q('a'), r('about a'), q('b')],
      body: 'about b',
    });
  });
  it('does not take a ">" still being typed in the reply for a card', () => {
    expect(splitThread('> a\n\nabout a\n> b')).toEqual({
      thread: [q('a')],
      body: 'about a\n> b',
    });
  });
  it('round-trips, keeping extra leading newlines in the body', () => {
    const body = '\n\ntyped  ';
    const thread = [q('x'), r('mid\nline'), q('y\nz')];
    expect(splitThread(joinThread(thread, body))).toEqual({ thread, body });
  });
  it('round-trips an emptied reply', () => {
    const thread = [q('x'), r(''), q('y')];
    expect(splitThread(joinThread(thread, 'b'))).toEqual({ thread, body: 'b' });
  });
});
