// Scrubbing for anything that leaves this install in a GitHub issue.
//
// The issue filer sends an ALLOWLIST of fields (see issue-filer.ts) and then
// runs every free-text one through `scrub`, which removes what can identify a
// person or a machine: home-directory paths, emails, hostnames and URLs, IP
// addresses, credentials and long opaque ids. It is a second line of defence;
// the first is that prompts and chat content are never fields at all.

const MAX_LINE = 400;

const RULES: [RegExp, string][] = [
  // Credentials first, so a token inside a URL or path is gone before they are cut up.
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '<token>'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '<token>'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '<token>'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '<token>'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <token>'],
  [
    /\b(token|secret|password|passwd|api[_-]?key|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi,
    '$1$2<redacted>',
  ],
  [/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s)"'<>]+/g, '<url>'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g, '<email>'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>'],
  [/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, '<ip>'],
  // Home directories on each OS: keep the path below the user's folder only.
  [/\/(?:home|Users)\/[^/\s)]+/g, '~'],
  [/[A-Za-z]:\\Users\\[^\\\s)]+/g, '~'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>'],
  [/\b[0-9a-f]{24,}\b/gi, '<id>'],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '<id>'],
];

/** Remove identifying and credential-like text; cut each line to a sane length. */
export function scrub(text: string): string {
  let out = text;
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out
    .split('\n')
    .map((l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}…` : l))
    .join('\n');
}

/** Scrub, then keep only the first `max` characters. */
export function scrubTo(text: string, max: number): string {
  const s = scrub(text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** The first stack frame that is not the message line, line/column removed. */
export function topFrame(stack: string | undefined): string {
  if (!stack) return '';
  const frame = stack.split('\n').find((l) => /^\s*at\s/.test(l));
  return frame ? scrub(frame.trim()).replace(/:\d+(:\d+)?\)?$/, '') : '';
}

/** A message with the parts that vary between occurrences flattened, for fingerprinting. */
export function normaliseMessage(message: string): string {
  return scrub(message.split('\n')[0] ?? '')
    .replace(/\d+/g, 'N')
    .slice(0, 200);
}
