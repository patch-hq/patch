// Working out when an account will run out, from the readings already taken.
//
// A refusal is the worst way to learn a pool is empty: the turn that finds out
// has already failed. On 29 Oct the work account went from 0% to 95% of its
// 5-hour window in 70 minutes, and the 10-minute probe saw nothing until Claude
// was refusing. Successive probes give a burn rate; the rate gives an instant.

import { EMPTY_UTILIZATION } from '@patch/wire';

/** An account this close to running out has its new turns sent elsewhere. */
export const NEARLY_OUT_MS = 10 * 60_000;

/** One probe's figure for one pool. */
export interface UsageSample {
  at: number;
  utilization: number;
  resetsAt?: number;
}

/** Readings this far apart in `resetsAt` are the same window (the stamp can jitter). */
const SAME_WINDOW_MS = 120_000;
/** Too short a span makes a rate out of rounding. */
const MIN_SPAN_MS = 60_000;

/**
 * When a pool is expected to hit empty, as ms-epoch, or undefined when there is
 * no honest estimate: fewer than two readings in the current window, no growth
 * across them, or a reset arriving first. `lookbackMs` is how much history the
 * rate is drawn from — recent enough to follow the current burn, long enough to
 * span several probes.
 */
export function projectRunOut(
  samples: readonly UsageSample[],
  lookbackMs: number,
  now: number,
): number | undefined {
  const latest = samples[samples.length - 1];
  if (latest === undefined) return undefined;
  // The window the readings describe has since reset: they say nothing now.
  if (latest.resetsAt !== undefined && latest.resetsAt <= now) return undefined;
  if (latest.utilization >= EMPTY_UTILIZATION) return latest.at;
  const sameWindow = samples.filter(
    (s) =>
      latest.at - s.at <= lookbackMs &&
      (latest.resetsAt === undefined || s.resetsAt === undefined
        ? latest.resetsAt === s.resetsAt
        : Math.abs(latest.resetsAt - s.resetsAt) <= SAME_WINDOW_MS),
  );
  const first = sameWindow[0]!;
  const span = latest.at - first.at;
  const grown = latest.utilization - first.utilization;
  if (span < MIN_SPAN_MS || grown <= 0) return undefined;
  const runOutAt = latest.at + ((EMPTY_UTILIZATION - latest.utilization) * span) / grown;
  if (latest.resetsAt !== undefined && latest.resetsAt <= runOutAt) return undefined;
  return runOutAt;
}

/** How often to probe an account, given what its pools are doing. */
export const PROBE_FAST_MS = 60_000;
export const PROBE_MEDIUM_MS = 3 * 60_000;
export const PROBE_SLOW_MS = 10 * 60_000;

export interface PoolForecast {
  scope: 'session' | 'week';
  utilization?: number;
  runOutAt?: number;
}

/**
 * Closer to the limit, look more often. The 5-hour pool is also tiered on its
 * figure; the week is judged on its run-out alone, because it sits high for days
 * and probing every few minutes for that whole time would buy nothing.
 */
export function probeIntervalMs(pools: readonly PoolForecast[], now: number): number {
  let interval = PROBE_SLOW_MS;
  for (const p of pools) {
    const until = p.runOutAt === undefined ? Infinity : p.runOutAt - now;
    const used = p.scope === 'session' ? (p.utilization ?? 0) : 0;
    if (until <= 3 * NEARLY_OUT_MS || used >= 0.9) interval = Math.min(interval, PROBE_FAST_MS);
    else if (until <= 9 * NEARLY_OUT_MS || used >= 0.75) {
      interval = Math.min(interval, PROBE_MEDIUM_MS);
    }
  }
  return interval;
}
