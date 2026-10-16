// The Manager sweep's one-line summary (spec/06 § Sweep — "Visible"): "Last
// sweep 14:30 · nudged 2 · flagged 1". Mirrors web's SweepStatusLine.

import type { SweepRun } from '../api/rest';

export function summarizeSweep(run: SweepRun): string {
  const counts: Record<string, number> = {};
  for (const a of run.actions) counts[a.action] = (counts[a.action] ?? 0) + 1;
  const parts: string[] = [];
  if (counts['nudge']) parts.push(`nudged ${counts['nudge']}`);
  if (counts['wake']) parts.push(`woke ${counts['wake']}`);
  if (counts['flag']) parts.push(`flagged ${counts['flag']}`);
  return parts.length === 0 ? 'nothing to do' : parts.join(' · ');
}

export function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
