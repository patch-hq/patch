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
