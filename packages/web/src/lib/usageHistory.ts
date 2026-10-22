// Settings → Usage history: the period picker's windows and the burndown's
// series. Pure so the page's arithmetic is tested without a DOM.

import type { UsageSample } from '@patch/wire';

export type UsagePeriod = 'day' | 'week' | 'month' | 'custom';
export const USAGE_PERIODS: readonly UsagePeriod[] = ['day', 'week', 'month', 'custom'];

const DAY_MS = 24 * 60 * 60 * 1000;
const SPAN: Record<Exclude<UsagePeriod, 'custom'>, number> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
};

/** The window a period names. A custom window runs from the start of `from` to the end of `to`. */
export function periodWindow(
  period: UsagePeriod,
  now: number,
  custom?: { from: string; to: string },
): { since: number; until: number } | null {
  if (period !== 'custom') return { since: now - SPAN[period], until: now };
  if (!custom?.from || !custom.to) return null;
  const since = Date.parse(`${custom.from}T00:00:00`);
  const until = Date.parse(`${custom.to}T23:59:59.999`);
  if (!Number.isFinite(since) || !Number.isFinite(until) || until < since) return null;
  return { since, until: Math.min(until, now) };
}

export interface BurndownPoint {
  ts: number;
  /** Percent of the weekly allowance still unspent, 0..100. */
  remaining: number;
}
export interface BurndownSeries {
  key: string;
  label: string;
  points: BurndownPoint[];
}

/** One line per account (and host): the weekly allowance left at each probe. */
export function buildBurndown(samples: (UsageSample & { hostId?: string })[]): BurndownSeries[] {
  const byKey = new Map<string, BurndownSeries>();
  for (const s of [...samples].sort((a, b) => a.ts - b.ts)) {
    if (s.week === undefined) continue;
    const key = `${s.hostId ?? ''}/${s.accountId}`;
    let series = byKey.get(key);
    if (!series) {
      series = { key, label: s.label, points: [] };
      byKey.set(key, series);
    }
    series.points.push({ ts: s.ts, remaining: Math.round((1 - s.week) * 1000) / 10 });
  }
  return [...byKey.values()];
}

export const CHATS_PER_PAGE = 10;

/** One page of the chats list (0-based), with the page clamped into range. */
export function pageOf<T>(
  items: readonly T[],
  page: number,
  size = CHATS_PER_PAGE,
): { rows: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(0, page), pages - 1);
  return { rows: items.slice(p * size, (p + 1) * size), page: p, pages };
}

/**
 * A weekly reset is a jump back UP in what is left. Anything smaller is
 * noise in a reading, not a reset.
 */
export const RESET_JUMP_PCT = 5;

/** The runs of a series between resets: each run starts at its own reset. */
export function splitAtResets(points: readonly BurndownPoint[]): BurndownPoint[][] {
  const runs: BurndownPoint[][] = [];
  let run: BurndownPoint[] = [];
  for (const p of points) {
    const last = run[run.length - 1];
    if (last && p.remaining - last.remaining > RESET_JUMP_PCT) {
      runs.push(run);
      run = [];
    }
    run.push(p);
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/**
 * Fritsch–Carlson monotone cubic through `pts`, as the commands after a
 * move-to. Monotone, so a curve between two readings never overshoots them:
 * a line drawn above 100% would be a reading that was never taken.
 */
function monotoneCurve(pts: readonly { x: number; y: number }[]): string {
  const n = pts.length;
  if (n < 2) return '';
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1]!.x - pts[i]!.x;
    d.push(dx === 0 ? 0 : (pts[i + 1]!.y - pts[i]!.y) / dx);
  }
  const m: number[] = new Array<number>(n).fill(0);
  m[0] = d[0]!;
  m[n - 1] = d[n - 2]!;
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / d[i]!;
    const b = m[i + 1]! / d[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i]!;
      m[i + 1] = t * b * d[i]!;
    }
  }
  let out = '';
  for (let i = 0; i < n - 1; i++) {
    const h = pts[i + 1]!.x - pts[i]!.x;
    const c1x = pts[i]!.x + h / 3;
    const c1y = pts[i]!.y + (m[i]! * h) / 3;
    const c2x = pts[i + 1]!.x - h / 3;
    const c2y = pts[i + 1]!.y - (m[i + 1]! * h) / 3;
    out += ` C${r(c1x)},${r(c1y)} ${r(c2x)},${r(c2y)} ${r(pts[i + 1]!.x)},${r(pts[i + 1]!.y)}`;
  }
  return out;
}

const r = (v: number): string => (Math.round(v * 10) / 10).toString();

/**
 * One series as an SVG path: a smooth curve within each cycle, and a straight
 * vertical step at each reset, so where every account's week starts is
 * visible rather than smeared across the hours between two probes.
 */
export function burndownPath(
  points: readonly BurndownPoint[],
  x: (ts: number) => number,
  y: (pct: number) => number,
): string {
  let d = '';
  for (const run of splitAtResets(points)) {
    const first = run[0]!;
    const pts = run.map((p) => ({ x: x(p.ts), y: y(p.remaining) }));
    d += `${d === '' ? 'M' : ' L'}${r(x(first.ts))},${r(y(first.remaining))}`;
    d += monotoneCurve(pts);
  }
  return d;
}
