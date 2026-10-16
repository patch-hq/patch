import { describe, it, expect } from 'vitest';
import { parseByteRanges } from '../src/byte-range.js';

describe('parseByteRanges', () => {
  it('no header, or a unit we do not honour, means serve the whole file', () => {
    expect(parseByteRanges(undefined, 10)).toBeNull();
    expect(parseByteRanges('items=0-1', 10)).toBeNull();
    expect(parseByteRanges('bytes=-', 10)).toBeNull();
  });

  it('parses one range', () => {
    expect(parseByteRanges('bytes=2-5', 10)).toEqual([{ start: 2, end: 5 }]);
    expect(parseByteRanges('bytes=7-', 10)).toEqual([{ start: 7, end: 9 }]);
    expect(parseByteRanges('bytes=-3', 10)).toEqual([{ start: 7, end: 9 }]);
    expect(parseByteRanges('bytes=0-99', 10)).toEqual([{ start: 0, end: 9 }]);
  });

  it('parses several ranges, in the order asked (electron-updater maps parts by index)', () => {
    expect(parseByteRanges('bytes=6-8, 0-1,3-4', 10)).toEqual([
      { start: 6, end: 8 },
      { start: 0, end: 1 },
      { start: 3, end: 4 },
    ]);
  });

  it('drops an unsatisfiable range when another is satisfiable', () => {
    expect(parseByteRanges('bytes=50-60, 1-2', 10)).toEqual([{ start: 1, end: 2 }]);
  });

  it('is unsatisfiable only when no range lies inside the file', () => {
    expect(parseByteRanges('bytes=50-60', 10)).toBe('unsatisfiable');
    expect(parseByteRanges('bytes=50-60,70-', 10)).toBe('unsatisfiable');
  });

  it('a suffix range on an empty file is unsatisfiable, not a negative span', () => {
    expect(parseByteRanges('bytes=-5', 0)).toBe('unsatisfiable');
  });

  it('a malformed spec makes the whole header ignorable', () => {
    expect(parseByteRanges('bytes=0-1,abc', 10)).toBeNull();
    expect(parseByteRanges('bytes=5-2', 10)).toBeNull();
  });
});
