// spec/15 § Chat detail — hand-off rows: what a row says of where its hand-off
// stands, worded as on web (spec/14 § Main chat panel — Hand-off rows).

import type { VoiceHandoffView } from '../stores/chatStore';

/** "0:24" while working; "1:02:33" past an hour. */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "38s", "2m 05s", "1h 02m". */
function took(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** The row's state, as it reads at `now`. Null for a record that has none. */
export function handoffStateLabel(h: VoiceHandoffView | undefined, now: number): string | null {
  if (!h) return null;
  switch (h.state) {
    case 'waiting':
      return 'waiting';
    case 'working':
      return `working ${clock(now - (h.startedAt ?? h.sentAt))}`;
    case 'answered':
      return `answered in ${took((h.endedAt ?? h.sentAt) - h.sentAt)}`;
    case 'failed':
      return 'failed';
  }
}

/** The seqs of every agent message drawn inside a hand-off's row. */
export function answerSeqsOf(handoffs: Record<number, VoiceHandoffView>): Set<number> {
  const seqs = new Set<number>();
  for (const h of Object.values(handoffs)) for (const seq of h.answerSeqs ?? []) seqs.add(seq);
  return seqs;
}
