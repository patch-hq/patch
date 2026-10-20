import { describe, it, expect } from 'vitest';
import { cutAt, stripWrappingQuotes } from '../src/textClean.js';
import { sanitizeTitle } from '../src/titleGen.js';

describe('stripWrappingQuotes', () => {
  it('removes quotes that wrap the text', () => {
    expect(stripWrappingQuotes('"Bus Route"')).toBe('Bus Route');
    expect(stripWrappingQuotes('“Bus Route”')).toBe('Bus Route');
    expect(stripWrappingQuotes('`x`')).toBe('x');
    expect(stripWrappingQuotes('""')).toBe('');
  });
  it('keeps quotes that belong to the text', () => {
    expect(stripWrappingQuotes('Fix the "login"')).toBe('Fix the "login"');
    expect(stripWrappingQuotes('"Foo" bar')).toBe('"Foo" bar');
    expect(stripWrappingQuotes('"Foo" vs "Bar"')).toBe('"Foo" vs "Bar"');
    expect(stripWrappingQuotes('“Foo” vs “Bar”')).toBe('“Foo” vs “Bar”');
  });

  it('only treats an apostrophe-shaped mark between letters as an apostrophe', () => {
    // A straight or curly double quote inside a word is still a quote mark,
    // so the outer pair is not the only one and stays.
    expect(stripWrappingQuotes('"a"b"')).toBe('"a"b"');
    expect(stripWrappingQuotes('“Re”quote”')).toBe('“Re”quote”');
    expect(stripWrappingQuotes('`x`y`')).toBe('`x`y`');
  });

  it('strips wrapping quotes around text with an apostrophe in a word', () => {
    expect(stripWrappingQuotes("'It's fine'")).toBe("It's fine");
    expect(stripWrappingQuotes('‘Don’t panic’')).toBe('Don’t panic');
  });
});

describe('cutAt', () => {
  it('never ends on half of a surrogate pair', () => {
    expect(cutAt('ab😀', 3)).toBe('ab');
    expect(cutAt('ab😀', 4)).toBe('ab😀');
    expect(cutAt('abc', 2)).toBe('ab');
  });
});

describe('sanitizeTitle', () => {
  it('keeps a quoted word at the end or start of a title', () => {
    expect(sanitizeTitle('Fix the "login"')).toBe('Fix the "login"');
    expect(sanitizeTitle('"Foo" bar')).toBe('"Foo" bar');
  });
  it('truncates without leaving a lone surrogate before the ellipsis', () => {
    const out = sanitizeTitle('a'.repeat(46) + '😀😀')!;
    expect(out.endsWith('…')).toBe(true);
    expect(/[\ud800-\udbff]…$/.test(out)).toBe(false);
  });
});
