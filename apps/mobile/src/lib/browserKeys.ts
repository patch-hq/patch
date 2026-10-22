// The hidden keyboard field the phone's browser view types through (spec/15 §
// Browser): Android reports nothing for Backspace on an empty field, so the
// field always holds one invisible character, and deleting it is a Backspace.

import type { BrowserHandoffInput } from '@patch/wire';

export const KEYS_SENTINEL = '​';

/**
 * The field is uncontrolled (defaultValue, never `value`): a controlled field is
 * rewritten to `value` by every re-render — a frame arriving is enough — which
 * silently desyncs what we think it holds. It is put back to the sentinel only
 * once emptied or grown this long: setNativeProps is asynchronous, and
 * resetting after every keystroke raced fast typing ("ab" reached the page as
 * "a" then "ab").
 */
export const KEYS_MAX = 64;

/**
 * What a change in the hidden field means for the page. `held` is what the
 * native field is believed to contain; it is updated here. Growth is typing,
 * shrinkage is Backspace (one per deleted character, the sentinel included).
 */
export function keysEvents(held: { current: string }, text: string): BrowserHandoffInput[] {
  const before = held.current;
  held.current = text;
  if (text.length < before.length) {
    return Array.from({ length: before.length - text.length }, () => ({
      kind: 'key' as const,
      key: 'Backspace',
    }));
  }
  const typed = (text.startsWith(before) ? text.slice(before.length) : text)
    .split(KEYS_SENTINEL)
    .join('');
  return typed.length > 0 ? [{ kind: 'text', text: typed }] : [];
}
