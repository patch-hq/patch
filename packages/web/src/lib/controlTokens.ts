// controlTokens — strip internal `[[…]]` control markers from message text
// before it is shown in a transcript bubble or a sidebar preview.
//
// The host's dev/SDK layer recognises bracketed control markers in a prompt
// ([[edit]], [[permission]], [[tool]], [[bash-permission]]) and turns them into
// their intended UI affordance (a file-edit tool call, a permission card, …).
// They are CONTROL tokens, not content — they
// must never leak into the rendered chat transcript as literal user/assistant
// text (spec/14: such tokens are "either suppressed or transformed into their
// intended UI affordance"). G2-d1.
//
// We strip ANY `[[word]]` token (not just the known set) so a future marker
// can't regress this, then tidy only the whitespace each removal leaves behind.
// Code is content, though: a fenced block or inline span (a TOML `[[bin]]`
// table) is left exactly as written.

const CONTROL_TOKEN_RE = /\[\[[a-z][a-z0-9_-]*\]\]/i;
// Code first (fenced blocks to their close or the end of an unfinished one,
// then inline spans), so a token inside it is matched as part of the code and
// kept; otherwise a token with the spaces/tabs either side, so a removal can
// close the gap.
const CODE_OR_TOKEN_RE =
  /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|[ \t]*\[\[[a-z][a-z0-9_-]*\]\][ \t]*/gi;

export function stripControlTokens(text: string): string {
  // Only touch text that actually carried a token: `[[ -f x ]]` in a shell
  // snippet has the brackets but nothing to strip.
  if (!CONTROL_TOKEN_RE.test(text)) return text;
  let removed = false;
  const out = text.replace(CODE_OR_TOKEN_RE, (match, offset: number) => {
    if (!match.trimStart().startsWith('[[')) return match;
    removed = true;
    const before = text[offset - 1];
    const after = text[offset + match.length];
    // "please [[edit]] the file" → "please the file"; at a line edge or before
    // punctuation ("do it [[edit]], now") the gap closes entirely.
    if (before === undefined || before === '\n') return '';
    if (after === undefined || after === '\n' || /[.,;:!?]/.test(after)) return '';
    return ' ';
  });
  // A marker alone on the first or last line leaves an empty line behind.
  return removed ? out.replace(/^\n+|\n+$/g, '') : out;
}
