// Text editing by code point, so an emoji (a UTF-16 surrogate pair) is never
// split in half by a backspace or a clip.

/** `s` without its last code point. */
export function dropLastCodePoint(s: string): string {
  return Array.from(s).slice(0, -1).join('');
}

/** `s` clipped to `max` code points, ending in `...` when it was longer. */
export function clipCodePoints(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max - 3).join('')}...` : s;
}
