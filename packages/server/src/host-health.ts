// Works out why a host dropped off (spec/03 § Host health). A host sends a
// `host.health` report with every heartbeat; the last one, with whether the
// machine said it was going to sleep, is what explains a `host.offline`.
// Nothing here warns anyone that a host is merely busy.

import { BATTERY_FLAT_PERCENT, type HostHealthEvent, type WireEvent } from '@patch/wire';

/** A sleep report this close to (or after) the last heartbeat explains the host dropping off. */
const SLEEP_SLACK_MS = 30_000;

export interface HostHealthTrackerDeps {
  now?: () => number;
}

interface HostRecord {
  lastReportAt: number;
  report: HostHealthEvent;
}

export class HostHealthTracker {
  private readonly hosts = new Map<string, HostRecord>();
  /** When each machine's own desktop app said it was going to sleep; gone again once it wakes. */
  private readonly asleepAt = new Map<string, number>();
  /** Why each host that is down went down, as far as we could tell. */
  private readonly offlineReasons = new Map<string, string>();
  private readonly now: () => number;

  constructor(deps: HostHealthTrackerDeps = {}) {
    this.now = deps.now ?? Date.now;
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
    this.hosts.set(event.hostId, { lastReportAt: this.now(), report: event });
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
}
