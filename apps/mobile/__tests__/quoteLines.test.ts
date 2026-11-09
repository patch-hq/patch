import { describe, expect, it } from 'vitest';
import { splitQuoteLines } from '../src/lib/quoteLines';

describe('splitQuoteLines', () => {
  it('groups consecutive > lines and strips the marker', () => {
    expect(splitQuoteLines('a\n> b\n>c\nd')).toEqual([
      { quote: false, text: 'a' },
      { quote: true, text: 'b\nc' },
      { quote: false, text: 'd' },
    ]);
  });
  it('leaves text without quotes as one run', () => {
    expect(splitQuoteLines('x\ny')).toEqual([{ quote: false, text: 'x\ny' }]);
  });
});
