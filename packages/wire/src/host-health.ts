// One copy of the rule for "is this host coping?", shared by the host (which
// holds new turns when memory is critical), the server (which tracks the state
// and tells surfaces) and every surface (which words it).

import type { HostConditionEvent, HostHealthEvent, HostProcessGroup } from './events.js';

/** How often a host reports its health. */
export const HOST_HEALTH_INTERVAL_MS = 15_000;
/** A report this many intervals late means the host or its link is struggling. */
export const HOST_HEALTH_LATE_INTERVALS = 3;

const GIB = 1024 ** 3;
const MEMORY_LOW_FRACTION = 0.1;
const MEMORY_CRITICAL_FRACTION = 0.04;
const SWAP_EXHAUSTED_FRACTION = 0.9;
const LOAD_PER_CPU = 4;
const EVENT_LOOP_LAG_MS = 1000;

export type HostReason = HostConditionEvent['reasons'][number];

export interface HostAssessment {
  reasons: HostReason[];
  /** Memory is so short that starting more work would get it killed. */
  critical: boolean;
}

/** What a single report says. `slow-link` is the server's own observation, not in a report. */
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

function formatBytes(bytes: number): string {
  if (bytes >= GIB) return `${Math.round(bytes / GIB)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** "5 vitest, 11 GB" */
export function describeProcessGroup(g: HostProcessGroup): string {
  return `${g.count > 1 ? `${g.count} ` : ''}${g.name}, ${formatBytes(g.rssBytes)}`;
}

/** The line a surface shows on a struggling host's chats. */
export function describeHostCondition(
  hostName: string,
  c: Pick<HostConditionEvent, 'reasons' | 'critical' | 'topProcesses'>,
): string {
  const [first] = c.reasons;
  const cause =
    first === 'memory'
      ? 'low on memory'
      : first === 'load'
        ? 'overloaded'
        : first === 'lag'
          ? 'running slowly'
          : 'slow to respond';
  const lead = `${hostName} is ${cause}`;
  const tail = c.critical ? 'new turns are on hold' : 'chats may be slow';
  const culprits = c.topProcesses.slice(0, 2).map(describeProcessGroup);
  return `${lead} — ${tail}${culprits.length > 0 ? ` (${culprits.join('; ')})` : ''}`;
}
