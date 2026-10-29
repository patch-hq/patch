// Tracks how each host is coping (spec/03 § Host health). A host sends a
// `host.health` report with every heartbeat; this turns the stream into a
// condition — online, or struggling and why — and tells surfaces when it
// changes. A report that arrives late is itself a sign: the host or its link is
// too slow to keep up, whatever the machine says about its own memory.
//
// A host that cannot be reached at all is not tracked here: that is
// `host.offline`, and the host's condition is forgotten when it happens.

import type { Logger } from 'pino';
import {
  assessHostHealth,
  describeHostCondition,
  HOST_HEALTH_INTERVAL_MS,
  HOST_HEALTH_LATE_INTERVALS,
  type HostConditionEvent,
  type HostHealthEvent,
  type HostReason,
  type WireEvent,
} from '@patch/wire';

/** Don't tell the user about the same host struggling again within this long. */
const NOTIFY_COOLDOWN_MS = 10 * 60_000;

export interface HostHealthTrackerDeps {
  logger: Logger;
  /** What the user calls this machine. */
  hostName: (hostId: string) => string;
  /** Tell every surface a host's condition changed. */
  broadcast: (event: HostConditionEvent) => void;
  /** One notification, when a host starts struggling. */
  notify: (message: string) => void;
  now?: () => number;
}

interface HostRecord {
  lastReportAt: number;
  intervalMs: number;
  report: HostHealthEvent;
  /** The condition surfaces were last told, as a comparable key. */
  publishedKey: string;
  struggling: boolean;
  lastNotifiedAt: number | null;
}

export class HostHealthTracker {
  private readonly hosts = new Map<string, HostRecord>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: HostHealthTrackerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Start watching for reports that stop arriving on time. */
  start(): void {
    this.timer = setInterval(() => this.sweep(), HOST_HEALTH_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  observe(event: WireEvent): void {
    if (event.type === 'host.offline') {
      this.hosts.delete(event.hostId);
      return;
    }
    if (event.type !== 'host.health') return;
    const report = event;
    const prev = this.hosts.get(report.hostId);
    this.hosts.set(report.hostId, {
      lastReportAt: this.now(),
      intervalMs: report.intervalMs,
      report,
      publishedKey: prev?.publishedKey ?? '',
      struggling: prev?.struggling ?? false,
      lastNotifiedAt: prev?.lastNotifiedAt ?? null,
    });
    this.publish(report.hostId);
  }

  /** The condition to greet a newly connected surface with; null when the host is fine. */
  conditionFor(hostId: string): HostConditionEvent | null {
    const rec = this.hosts.get(hostId);
    if (!rec) return null;
    const c = this.condition(hostId, rec);
    return c.state === 'struggling' ? c : null;
  }

  private condition(hostId: string, rec: HostRecord): HostConditionEvent {
    const { reasons, critical } = assessHostHealth(rec.report);
    const all: HostReason[] = [...reasons];
    const lateMs = rec.intervalMs * HOST_HEALTH_LATE_INTERVALS;
    if (this.now() - rec.lastReportAt > lateMs) all.push('slow-link');
    return {
      type: 'host.condition',
      hostId,
      state: all.length > 0 ? 'struggling' : 'online',
      critical,
      reasons: all,
      topProcesses: all.includes('memory') ? rec.report.topProcesses : [],
    };
  }

  /** Re-judge every host against the clock: a report that has not come is news too. */
  sweep(): void {
    for (const hostId of this.hosts.keys()) this.publish(hostId);
  }

  private publish(hostId: string): void {
    const rec = this.hosts.get(hostId);
    if (!rec) return;
    const c = this.condition(hostId, rec);
    const key = JSON.stringify([
      c.state,
      c.critical,
      c.reasons,
      c.topProcesses.map((p) => [p.name, p.count]),
    ]);
    if (key === rec.publishedKey) return;
    const wasStruggling = rec.struggling;
    rec.publishedKey = key;
    rec.struggling = c.state === 'struggling';
    this.deps.logger.warn(
      { hostId, state: c.state, critical: c.critical, reasons: c.reasons },
      'host condition changed',
    );
    this.deps.broadcast(c);
    const startedStruggling = c.state === 'struggling' && !wasStruggling;
    if (
      startedStruggling &&
      (rec.lastNotifiedAt === null || this.now() - rec.lastNotifiedAt > NOTIFY_COOLDOWN_MS)
    ) {
      rec.lastNotifiedAt = this.now();
      this.deps.notify(describeHostCondition(this.deps.hostName(hostId), c));
    }
  }
}
