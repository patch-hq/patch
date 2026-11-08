// spec/07 § The fast voice and the chat's agent — the `[call]` marker lines the
// host writes around a hand-off. The transcript shows a hand-off as one line:
// working (with a timer) until the agent answers, then a thin rule.

export type CallMarker =
  | { kind: 'working'; startedAt: number; request: string }
  | { kind: 'answered'; startedAt: number; ms: number }
  | { kind: 'failed'; startedAt: number; reason: string }
  | { kind: 'voice' };

export function parseCallMarker(content: string): CallMarker | null {
  if (!content.startsWith('[call] ')) return null;
  const line = content.slice('[call] '.length);
  if (line === 'voice') return { kind: 'voice' };
  const m = /^(agent-working|agent-answered|agent-failed) (\d+)(?: (.*))?$/s.exec(line);
  if (!m) return null;
  const startedAt = Number(m[2]);
  const rest = m[3] ?? '';
  if (m[1] === 'agent-working') return { kind: 'working', startedAt, request: rest };
  if (m[1] === 'agent-answered') return { kind: 'answered', startedAt, ms: Number(rest) };
  return { kind: 'failed', startedAt, reason: rest };
}

/** How each hand-off in a timeline ended, keyed by its start time. Absent = still working. */
export function handoffOutcomes(
  timeline: readonly { kind: string; content?: string }[],
): Map<number, CallMarker> {
  const out = new Map<number, CallMarker>();
  for (const e of timeline) {
    if (e.kind !== 'message') continue;
    const m = parseCallMarker(e.content ?? '');
    if (m && (m.kind === 'answered' || m.kind === 'failed')) out.set(m.startedAt, m);
  }
  return out;
}

export function formatHandoffElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
