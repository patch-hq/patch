import type { ChatEventEntry } from '../stores/chatStore.js';

// spec/14 § Attempt pager — a turn the host re-sent is ONE bubble whose
// attempts are paged. The replies each attempt produced sit in the timeline
// after that bubble, so paging has to hide the replies of the attempts not
// shown, not just swap an error line.

export interface AttemptPaging {
  /** Timeline indices belonging to an attempt other than the shown one. */
  hidden: Set<number>;
  /** Anchor user seq → true when an attempt has replies or a failure to page to. */
  pageable: Map<number, boolean>;
}

const isTurnStart = (e: ChatEventEntry): boolean =>
  e.kind === 'message' && e.role === 'user' && e.queued !== true;

export function attemptPaging(
  timeline: readonly ChatEventEntry[],
  selected: ReadonlyMap<number, number>,
): AttemptPaging {
  const hidden = new Set<number>();
  const pageable = new Map<number, boolean>();
  for (let i = 0; i < timeline.length; i++) {
    const anchor = timeline[i]!;
    const attempts = anchor.attempts;
    if (!isTurnStart(anchor) || attempts === undefined || attempts.length < 2) continue;
    const shown = Math.min(selected.get(anchor.seq) ?? attempts.length - 1, attempts.length - 1);
    let hasContent = attempts.some((a) => a.error !== undefined);
    for (let j = i + 1; j < timeline.length; j++) {
      const e = timeline[j]!;
      if (isTurnStart(e)) break;
      if (e.seq < anchor.seq) continue;
      let owner = 0;
      for (let k = 0; k < attempts.length; k++) if (attempts[k]!.seq <= e.seq) owner = k;
      if (owner !== attempts.length - 1) hasContent = true;
      if (owner !== shown) hidden.add(j);
    }
    pageable.set(anchor.seq, hasContent);
  }
  return { hidden, pageable };
}
