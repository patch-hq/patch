// Tracks how each host is coping (spec/03 § Host health). A host sends a
// `host.health` report with every heartbeat; this turns the stream into a
// condition — online, or struggling and why — and tells surfaces when it
// changes — a banner, never a notification. A report that arrives late is
// itself a sign: the host or its link is too slow to keep up, whatever the
// machine says about its own memory.
//
// A host that cannot be reached at all is not tracked here: that is
// `host.offline`, and the host's condition is forgotten when it happens.

import type { Logger } from 'pino';
import {
  assessHostHealth,
  HOST_HEALTH_INTERVAL_MS,
  HOST_HEALTH_LATE_INTERVALS,
  BATTERY_FLAT_PERCENT,
  type HostConditionEvent,
  type HostHealthEvent,
  type HostReason,
  type WireEvent,
} from '@patch/wire';

/** A sleep report this close to (or after) the last heartbeat explains the host dropping off. */
const SLEEP_SLACK_MS = 30_000;

export interface HostHealthTrackerDeps {
  logger: Logger;
  /** What the user calls this machine. */
  hostName: (hostId: string) => string;
  /** Tell every surface a host's condition changed. */
  broadcast: (event: HostConditionEvent) => void;
  now?: () => number;
}

interface HostRecord {
  lastReportAt: number;
  intervalMs: number;
  report: HostHealthEvent;
  /** The condition surfaces were last told, as a comparable key. */
  publishedKey: string;
  struggling: boolean;
}

export class HostHealthTracker {
  private readonly hosts = new Map<string, HostRecord>();
  /** When each machine's own desktop app said it was going to sleep; gone again once it wakes. */
  private readonly asleepAt = new Map<string, number>();
  /** Why each host that is down went down, as far as we could tell. */
  private readonly offlineReasons = new Map<string, string>();
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
    if (event.type === 'host.online') {
      this.offlineReasons.delete(event.hostId);
      return;
    }
    if (event.type === 'host.offline') {
      this.noteOffline(event.hostId);
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
    });
    this.publish(report.hostId);
  }

  /** The machine's own desktop app reported going to sleep, or being awake again. */
  noteAsleep(hostId: string, asleep: boolean): void {
    if (asleep) {
      if (!this.asleepAt.has(hostId)) this.asleepAt.set(hostId, this.now());
    } else {
      this.asleepAt.delete(hostId);
    }
  }

  /** Why a host that is down went down: its last heartbeat, and whether its machine said it slept. */
  offlineReason(hostId: string): string | undefined {
    return this.offlineReasons.get(hostId);
  }

  private noteOffline(hostId: string): void {
    const rec = this.hosts.get(hostId);
    if (rec === undefined) return; // never reported: nothing to explain it with
    const slept = this.asleepAt.get(hostId);
    const reason =
      rec.report.power?.onBattery && rec.report.power.percent <= BATTERY_FLAT_PERCENT
        ? 'battery'
        : slept !== undefined && slept >= rec.lastReportAt - SLEEP_SLACK_MS
          ? 'asleep'
          : 'unresponsive';
    this.offlineReasons.set(hostId, reason);
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
      ...(all.includes('battery') && rec.report.power
        ? { batteryPercent: rec.report.power.percent }
        : {}),
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
    rec.publishedKey = key;
    rec.struggling = c.state === 'struggling';
    this.deps.logger.warn(
      { hostId, state: c.state, critical: c.critical, reasons: c.reasons },
      'host condition changed',
    );
    this.deps.broadcast(c);
  }
}
