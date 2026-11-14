// Waypoints for the long-chat scroll rail: a handful of points down a long
// transcript, each labelled with the date (or, within one day, the time) of the
// turn it lands on. Pure, so the choice of points is testable without a DOM.

export interface RailEntry {
  seq: number;
  kind: string;
  role?: string;
  queued?: boolean;
  messageAt?: number;
}

export interface RailMarker {
  seq: number;
  label: string;
}

export const RAIL_MAX_MARKERS = 8;

const dayKey = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getFullYear())}-${String(d.getMonth())}-${String(d.getDate())}`;
};

const dateLabel = (ms: number): string =>
  new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

const timeLabel = (ms: number): string =>
  new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** `count` indices spread evenly over `length`, always including the first and last. */
function spread(length: number, count: number): number[] {
  if (length <= count) return Array.from({ length }, (_, i) => i);
  const out: number[] = [];
  for (let k = 0; k < count; k++) out.push(Math.round((k * (length - 1)) / (count - 1)));
  return out;
}

export function railMarkers(timeline: readonly RailEntry[]): RailMarker[] {
  const turns = timeline.filter(
    (e) =>
      e.kind === 'message' && e.role === 'user' && !e.queued && typeof e.messageAt === 'number',
  );
  if (turns.length < 2) return [];
  const at = (e: RailEntry): number => e.messageAt ?? 0;

  const firstOfDay: RailEntry[] = [];
  let lastDay = '';
  for (const e of turns) {
    const k = dayKey(at(e));
    if (k !== lastDay) firstOfDay.push(e);
    lastDay = k;
  }

  // Several days: one marker per day, labelled with the date.
  if (firstOfDay.length > 1) {
    return spread(firstOfDay.length, RAIL_MAX_MARKERS).map((i) => {
      const e = firstOfDay[i] as RailEntry;
      return { seq: e.seq, label: dateLabel(at(e)) };
    });
  }
  // One day: spread over the turns, labelled with the time.
  return spread(turns.length, RAIL_MAX_MARKERS).map((i) => {
    const e = turns[i] as RailEntry;
    return { seq: e.seq, label: timeLabel(at(e)) };
  });
}

/**
 * Whether the reader looks to be heading a long way up. Upward scrolling is
 * accumulated across a burst (a pause or a turn back down resets it), and only
 * a burst worth several screens counts — an ordinary look back never does.
 */
export const FAR_SCREENS = 3;
export const FAR_BURST_GAP_MS = 1500;

export interface FarState {
  up: number;
  lastAt: number;
}

export function nextFarState(prev: FarState, delta: number, now: number): FarState {
  if (delta >= 0) return { up: 0, lastAt: now };
  const base = now - prev.lastAt > FAR_BURST_GAP_MS ? 0 : prev.up;
  return { up: base - delta, lastAt: now };
}

export const isFar = (state: FarState, viewport: number): boolean =>
  viewport > 0 && state.up >= viewport * FAR_SCREENS;
