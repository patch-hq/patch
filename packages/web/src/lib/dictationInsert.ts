// Where dictated words land in the draft: at the caret, not the end, and the
// caret moves to just after them so the user keeps their place.

export interface DictationInsert {
  text: string;
  /** Caret position after the inserted words. */
  caret: number;
}

/** Insert `words` into `draft` at `caret` (clamped), spacing them from neighbours. */
export function insertDictation(draft: string, caret: number, words: string): DictationInsert {
  const pos = Math.max(0, Math.min(caret, draft.length));
  const before = draft.slice(0, pos);
  const after = draft.slice(pos);
  if (words === '') return { text: draft, caret: pos };
  const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
  const trail = after.length > 0 && !/^\s/.test(after) ? ' ' : '';
  const head = `${before}${lead}${words}`;
  return { text: `${head}${trail}${after}`, caret: head.length };
}
