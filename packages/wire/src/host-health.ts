// One copy of the rule for "is this host coping?": the host holds new turns
// when memory is critical.

import type { HostHealthEvent } from './events.js';

/** How often a host reports its health. */
export const HOST_HEALTH_INTERVAL_MS = 15_000;

const MEMORY_LOW_FRACTION = 0.1;
const MEMORY_CRITICAL_FRACTION = 0.04;
const SWAP_EXHAUSTED_FRACTION = 0.9;
const LOAD_PER_CPU = 4;
const EVENT_LOOP_LAG_MS = 1000;

export type HostReason = 'memory' | 'load' | 'lag';

export interface HostAssessment {
  reasons: HostReason[];
  /** Memory is so short that starting more work would get it killed. */
  critical: boolean;
}

/** What a single report says. */
export function assessHostHealth(
  report: Pick<
    HostHealthEvent,
    | 'memTotalBytes'
    | 'memAvailableBytes'
    | 'swapTotalBytes'
    | 'swapUsedBytes'
    | 'load1'
    | 'cpuCount'
    | 'eventLoopLagMs'
    | 'power'
  >,
): HostAssessment {
  const reasons: HostReason[] = [];
  let critical = false;
  const { memTotalBytes: total, memAvailableBytes: available } = report;
  if (total !== undefined && total > 0 && available !== undefined) {
    const free = available / total;
    const swapGone =
      report.swapTotalBytes !== undefined &&
      report.swapTotalBytes > 0 &&
      report.swapUsedBytes !== undefined &&
      report.swapUsedBytes / report.swapTotalBytes >= SWAP_EXHAUSTED_FRACTION;
    if (free < MEMORY_LOW_FRACTION) {
      reasons.push('memory');
      critical = free < MEMORY_CRITICAL_FRACTION || swapGone;
    }
  }
  if (report.load1 / report.cpuCount > LOAD_PER_CPU) reasons.push('load');
  if (report.eventLoopLagMs > EVENT_LOOP_LAG_MS) reasons.push('lag');
  return { reasons, critical };
}

/** How long a host that looked strained when it dropped is called busy before it reads as offline. */
export const HOST_BUSY_WINDOW_MS = 120_000;

const BUSY_PREFIX = 'busy:';
const BUSY_WHY: Record<HostReason, string> = {
  memory: 'low memory',
  load: 'heavy CPU load',
  lag: 'a stalled process',
};

/** The offline reason for a host whose last report showed it struggling: `busy:load`. */
export function busyOfflineReason(reasons: HostReason[]): string | undefined {
  const first = reasons[0];
  return first === undefined ? undefined : `${BUSY_PREFIX}${first}`;
}

/**
 * Why a host dropped off, in a sentence fragment: "Mac went to sleep". A host that was
 * struggling when it went quiet reads as busy until it has been gone for HOST_BUSY_WINDOW_MS.
 */
export function describeHostOffline(
  hostName: string,
  reason: string | undefined,
  offlineForMs?: number,
): string {
  if (reason === 'asleep') return `${hostName} went to sleep`;
  if (reason?.startsWith(BUSY_PREFIX)) {
    const why = BUSY_WHY[reason.slice(BUSY_PREFIX.length) as HostReason];
    const recent = offlineForMs === undefined || offlineForMs < HOST_BUSY_WINDOW_MS;
    if (why !== undefined && recent) return `${hostName} is busy (${why}), retrying`;
    return `${hostName} is offline`;
  }
  if (reason === 'unresponsive') return `${hostName} stopped responding`;
  return `${hostName} is offline`;
}
