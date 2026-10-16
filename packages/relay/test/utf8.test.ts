import { describe, expect, it } from 'vitest';
import { utf8Decode, utf8Encode } from '../src/utf8.js';

describe('utf8', () => {
  it.each(['', 'plain', 'é ñ ü', '✓ → €', '日本語', '😀 emoji 🎉', 'mixed ascii é ✓ 😀'])(
    'matches the platform for %s',
    (s) => {
      expect(Array.from(utf8Encode(s))).toEqual(Array.from(new TextEncoder().encode(s)));
      expect(utf8Decode(new TextEncoder().encode(s))).toBe(s);
    },
  );

  it('replaces bytes that are not UTF-8 rather than throwing', () => {
    expect(utf8Decode(Uint8Array.of(0x61, 0xff, 0x62))).toBe('a�b');
    expect(utf8Decode(Uint8Array.of(0xe2, 0x82))).toBe('��');
    expect(utf8Decode(Uint8Array.of(0xc3, 0x28))).toBe('�(');
  });

  it('replaces a code point above U+10FFFF instead of throwing', () => {
    expect(() => utf8Decode(Uint8Array.of(0xf4, 0x90, 0x80, 0x80))).not.toThrow();
    expect(utf8Decode(Uint8Array.of(0xf4, 0x90, 0x80, 0x80))).toBe('����');
  });

  it('does not accept overlong forms or encoded surrogates', () => {
    expect(utf8Decode(Uint8Array.of(0xe0, 0x80, 0x80))).not.toContain('\0');
    expect(utf8Decode(Uint8Array.of(0xf0, 0x80, 0x80, 0x80))).not.toContain('\0');
    // ED A0 80 is U+D800, a lone surrogate.
    expect(utf8Decode(Uint8Array.of(0xed, 0xa0, 0x80))).toBe('���');
  });
});
