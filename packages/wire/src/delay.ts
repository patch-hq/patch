// One duration grammar for the whole system (host scheduler + server route validation).

/**
 * Parse a relative `in` duration → milliseconds. Accepts `"10m"`, `"1h30m"`,
 * `"90s"`, `"2h"`, spelled-out `"2 hours"` / `"1 hour 30 minutes"`, a bare number (seconds), or ISO-8601 `"PT10M"`. Throws on
 * anything else (NO silent fallback).
 */
export function parseDelayMs(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new Error(`invalid delay: ${input}`);
    return Math.round(input * 1000);
  }
  const s = input.trim();
  if (s === '') throw new Error('invalid delay: empty');
  const iso = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(s);
  if (iso && (iso[1] ?? iso[2] ?? iso[3])) {
    return (Number(iso[1] ?? 0) * 3600 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0)) * 1000;
  }
  // Spelled-out units ("2 hours", "1 hour 30 minutes", "90 secs") fold into the
  // compact form. Only whole numbers followed by a known unit word are accepted.
  const compactS = s
    .replace(/(\d)\s*(hours?|hrs?)\b/gi, '$1h')
    .replace(/(\d)\s*(minutes?|mins?)\b/gi, '$1m')
    .replace(/(\d)\s*(seconds?|secs?)\b/gi, '$1s')
    .replace(/(?<=[hms])\s*(?:and\s+)?(?=\d)/gi, '')
    .replace(/(\d)\s+(?=[hms]\b)/gi, '$1');
  const compact = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(compactS);
  if (compact && (compact[1] ?? compact[2] ?? compact[3])) {
    return (
      (Number(compact[1] ?? 0) * 3600 + Number(compact[2] ?? 0) * 60 + Number(compact[3] ?? 0)) *
      1000
    );
  }
  // Bare number = seconds (must be a pure numeric string, not "" or "1x").
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  throw new Error(`invalid delay: ${input}`);
}
