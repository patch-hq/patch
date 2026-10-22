// Text the user must act on (`patch_ask_human`'s task and why): a sign-in URL
// to open, a device code to type. Both surfaces draw it as a card, so the
// split lives here and neither re-derives what counts as a link or a code.

export type ActionSegment =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'code'; text: string };

/** http(s) URLs up to whitespace; trailing sentence punctuation is not part of the link. */
const URL_RE = /https?:\/\/[^\s<>"']+/g;

/**
 * A device/verification code: groups of 3-6 capitals/digits joined by hyphens
 * (`ABCD-EFGH`, `WDJB-MJHT`), at least one group with a letter-or-digit mix not
 * being ordinary prose. Lowercase never matches, so words and dates do not.
 */
const CODE_RE = /(?<![A-Za-z0-9-])[A-Z0-9]{3,6}(?:-[A-Z0-9]{3,6})+(?![A-Za-z0-9-])/g;

const TRAILING_PUNCT = /[.,;:!?)\]]+$/;

export function splitActionText(input: string): ActionSegment[] {
  const marks: { start: number; end: number; seg: ActionSegment }[] = [];
  for (const m of input.matchAll(URL_RE)) {
    const raw = m[0];
    const trimmed = raw.replace(TRAILING_PUNCT, '');
    marks.push({
      start: m.index,
      end: m.index + trimmed.length,
      seg: { kind: 'link', text: trimmed, href: trimmed },
    });
  }
  for (const m of input.matchAll(CODE_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (marks.some((k) => start < k.end && end > k.start)) continue;
    marks.push({ start, end, seg: { kind: 'code', text: m[0] } });
  }
  marks.sort((a, b) => a.start - b.start);
  const out: ActionSegment[] = [];
  let at = 0;
  for (const k of marks) {
    if (k.start > at) out.push({ kind: 'text', text: input.slice(at, k.start) });
    out.push(k.seg);
    at = k.end;
  }
  if (at < input.length) out.push({ kind: 'text', text: input.slice(at) });
  return out;
}

/** The `patch_ask_human` arguments, or null when they are not its shape. */
export function parseAskHuman(args: unknown): { task: string; why?: string } | null {
  if (typeof args !== 'object' || args === null) return null;
  const { task, why } = args as Record<string, unknown>;
  if (typeof task !== 'string' || task.length === 0) return null;
  return typeof why === 'string' && why.length > 0 ? { task, why } : { task };
}
