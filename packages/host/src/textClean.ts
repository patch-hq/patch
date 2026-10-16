// Small text helpers shared by the generators that turn a model reply into a
// short label (titles, statuses, summaries).

const QUOTES = '"\'`“”‘’';

/**
 * Strip quotes that WRAP the text: only when it both starts and ends with one
 * and neither appears inside, so `"Bus Route"` loses them but `Fix the "login"`,
 * `"Foo" bar` and `"Foo" vs "Bar"` keep theirs.
 */
export function stripWrappingQuotes(text: string): string {
  let t = text;
  while (t.length >= 2 && QUOTES.includes(t[0]!) && QUOTES.includes(t[t.length - 1]!)) {
    const inner = t.slice(1, -1);
    if (quotesInside(inner, t[0]!) || quotesInside(inner, t[t.length - 1]!)) break;
    t = inner;
  }
  // A lone unmatched pair of quote marks, e.g. `""`, collapses to nothing above;
  // a single leftover quote is content, not wrapping.
  return t;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Whether `q` appears in `text` as a quote mark — an apostrophe inside a
 * word (`It's`, `don’t`) is not one. */
function quotesInside(text: string, q: string): boolean {
  for (let i = text.indexOf(q); i !== -1; i = text.indexOf(q, i + 1)) {
    if (!(WORD_CHAR.test(text[i - 1] ?? '') && WORD_CHAR.test(text[i + 1] ?? ''))) return true;
  }
  return false;
}

/** `text.slice(0, n)` that never ends on half of a surrogate pair. */
export function cutAt(text: string, n: number): string {
  const head = text.slice(0, n);
  const last = head.charCodeAt(head.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}
