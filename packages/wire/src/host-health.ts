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
/** Battery at or below this, and not charging, is worth saying. */
const BATTERY_LOW_PERCENT = 15;
/** At or below this and discharging when it drops off, a host is taken to have run flat. */
export const BATTERY_FLAT_PERCENT = 10;

export type HostReason = 'memory' | 'battery' | 'load' | 'lag';

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
  if (report.power?.onBattery && report.power.percent <= BATTERY_LOW_PERCENT)
    reasons.push('battery');
  if (report.load1 / report.cpuCount > LOAD_PER_CPU) reasons.push('load');
  if (report.eventLoopLagMs > EVENT_LOOP_LAG_MS) reasons.push('lag');
  return { reasons, critical };
}

/** Why a host dropped off, in a sentence fragment: "Mac went to sleep". */
export function describeHostOffline(hostName: string, reason: string | undefined): string {
  if (reason === 'battery') return `${hostName} ran out of battery`;
  if (reason === 'asleep') return `${hostName} went to sleep`;
  if (reason === 'unresponsive') return `${hostName} stopped responding`;
  return `${hostName} is offline`;
}
