// jobToken — the `!` trigger that runs a job from the composer (spec/15 §
// Composer — Run a job). A mirror of the web composer's
// `packages/web/src/lib/jobToken.ts` (the two apps share no package). `/` is
// taken by skills, so jobs get their own character; same word-start rule.
export interface ActiveBangToken {
  /** Index of the `!` itself. */
  start: number;
  /** Everything typed after the `!` so far (may be empty). */
  query: string;
}

export function activeBangToken(text: string, cursor: number): ActiveBangToken | null {
  const m = /(^|\s)!(\S*)$/.exec(text.slice(0, cursor));
  if (!m) return null;
  const query = m[2] ?? '';
  return { start: cursor - query.length - 1, query };
}

/** Remove the token (`!` + query) from `text`, leaving the rest untouched. */
export function removeBangToken(
  text: string,
  token: ActiveBangToken,
  cursor: number,
): { text: string; cursor: number } {
  let end = cursor;
  // Swallow one space left behind so "run !job now" doesn't keep a double space.
  if (token.start > 0 && /\s/.test(text[token.start - 1] ?? '') && /^\s/.test(text.slice(end))) {
    end += 1;
  }
  return { text: text.slice(0, token.start) + text.slice(end), cursor: token.start };
}

/** Jobs matching `query` (name or id), best first: prefix, then substring, then letters in order. */
export function filterJobs<T extends { id: string; name: string }>(jobs: T[], query: string): T[] {
  const q = query.toLowerCase();
  const subseq = (n: string): boolean => {
    let i = 0;
    for (const ch of n) if (ch === q[i] && ++i === q.length) return true;
    return q.length === 0;
  };
  const scored: { job: T; tier: number; at: number }[] = [];
  jobs.forEach((job, at) => {
    const n = job.name.toLowerCase();
    const tier =
      q === '' || n.startsWith(q)
        ? 0
        : n.includes(q) || job.id.toLowerCase().includes(q)
          ? 1
          : subseq(n)
            ? 2
            : null;
    if (tier !== null) scored.push({ job, tier, at });
  });
  scored.sort((a, b) => a.tier - b.tier || a.at - b.at);
  return scored.map((s) => s.job);
}
