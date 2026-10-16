// lib/longPaste.ts — naming the document a long paste becomes.

import { describe, it, expect } from 'vitest';
import { extractLongPaste, LONG_PASTE_CHARS, pastedTextName } from '../src/lib/longPaste';

describe('pastedTextName', () => {
  it('names the paste after its first words', () => {
    expect(pastedTextName('Hello   there\nworld')).toBe('Pasted – Hello there world.md');
    expect(pastedTextName('   ')).toBe('Pasted text.md');
  });

  it('cuts a long name on a code point, never through half of an emoji', () => {
    const name = pastedTextName(`a${'😀'.repeat(41)}`);
    expect(name).toBe(`Pasted – a${'😀'.repeat(39)}….md`);
  });
});

describe('extractLongPaste', () => {
  const body = 'x'.repeat(LONG_PASTE_CHARS);

  it('lifts the pasted block out of the middle of the text', () => {
    expect(extractLongPaste('ab', `a${body}b`)).toEqual({ inserted: body, remaining: 'ab' });
  });

  it('never cuts an emoji in half when its neighbour shares a surrogate with the paste edge', () => {
    // 😀 and 😁 share the high surrogate, so a code-unit diff stops mid-pair.
    const lead = extractLongPaste('😀hi', `😁${body}😀hi`)!;
    expect(lead.inserted).toBe(`😁${body}`);
    expect(lead.remaining).toBe('😀hi');
    // 😀 and 😃 share the low surrogate's neighbour on the trailing side too.
    const tail = extractLongPaste('hi😀', `hi${body}😃😀`)!;
    expect(tail.inserted).toBe(`${body}😃`);
    expect(tail.remaining).toBe('hi😀');
  });
});
