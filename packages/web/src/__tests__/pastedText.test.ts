// A long paste is attached as `Pasted – <first words>.md`; the name is cut to
// fit, and the cut must never split a character in two.

import { describe, it, expect } from 'vitest';
import { pastedTextName } from '../lib/pastedText.js';

describe('pastedTextName', () => {
  it('names the paste from its first words', () => {
    expect(pastedTextName('Meeting notes: Q3 plan')).toBe('Pasted – Meeting notes Q3 plan.md');
  });

  it('falls back when nothing nameable remains', () => {
    expect(pastedTextName('  //  ')).toBe('Pasted text.md');
  });

  it('cuts on code points, never leaving half of a surrogate pair', () => {
    const name = pastedTextName(`${'a'.repeat(39)}😀b`);
    expect(name).toBe(`Pasted – ${'a'.repeat(39)}😀….md`);
    expect(name).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
