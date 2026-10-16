// Cutting text by code point, so an emoji (a UTF-16 surrogate pair) is never
// split in half and left as a lone surrogate.

/** The first `max` code points of `s`. */
export function headCodePoints(s: string, max: number): string {
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join('');
}

/** The last `max` code points of `s`. */
export function tailCodePoints(s: string, max: number): string {
  if (s.length <= max) return s;
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(chars.length - max).join('');
}
