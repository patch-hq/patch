import { describe, expect, it } from 'vitest';
import { insertDictation } from './dictationInsert.js';

describe('insertDictation', () => {
  it('appends with a space when the caret is at the end', () => {
    expect(insertDictation('hello', 5, 'world')).toEqual({ text: 'hello world', caret: 11 });
  });
  it('inserts mid-draft and leaves the caret after the words', () => {
    expect(insertDictation('ab cd', 2, 'XX')).toEqual({ text: 'ab XX cd', caret: 5 });
  });
  it('does not double spaces that are already there', () => {
    expect(insertDictation('ab  cd', 3, 'XX')).toEqual({ text: 'ab XX cd', caret: 5 });
  });
  it('lands at the start of an empty draft with no padding', () => {
    expect(insertDictation('', 0, 'hi')).toEqual({ text: 'hi', caret: 2 });
  });
  it('clamps an out-of-range caret', () => {
    expect(insertDictation('a', 99, 'b').text).toBe('a b');
  });
  it('is a no-op for no words', () => {
    expect(insertDictation('abc', 1, '')).toEqual({ text: 'abc', caret: 1 });
  });
});
