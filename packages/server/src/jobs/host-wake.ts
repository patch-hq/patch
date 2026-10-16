// Wake host (spec/08 § Wake host).
//
// A job with `wakeHost` has its macOS host asked, while that host is awake, to
// schedule a wake `leadMs` before the job's next cron fire. The request is
// re-sent every minute only when the fire time changes (or the host reconnects),
// and the host's answer is checked: a wake that could not be scheduled raises a
// notification instead of failing silently into a missed run.

import type { Logger } from 'pino';
import type { HostWakeRequestEvent, HostWakeResultEvent } from '@patch/wire';
import type { HostLink } from '../host-link.js';
import type { Job, JobsInterface } from './types.js';

const SURFACE_ID = 'job-wake';
const TICK_MS = 60_000;
export const DEFAULT_WAKE_LEAD_MS = 60_000;

export interface HostWakerOptions {
  jobs: Pick<JobsInterface, 'list'>;
  hostLink: HostLink;
  logger: Logger;
  /** Next fire of a job's live cron task. */
  nextRun: (jobId: string) => Date | null;
  /** The host a job's fire is addressed to; null when it has none. */
  hostFor: (job: Job) => string | null;
  /** Called when a host cannot schedule the wake. */
  onFailure: (info: { job: Job; hostId: string | null; at: number; error: string }) => void;
  nowMs?: () => number;
  leadMs?: number;
}

export class HostWaker {
  private readonly o: HostWakerOptions;
  private readonly sent = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubs: Array<() => void> = [];

  constructor(opts: HostWakerOptions) {
    this.o = opts;
  }

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
    this.unsubs.push(
      // A reconnected host may have restarted and lost nothing, or been wiped:
      // ask again rather than assume.
      this.o.hostLink.onStatus((s) => {
        if (s === 'online') {
          this.sent.clear();
          this.tick();
        }
      }),
      this.o.hostLink.onEvent((event) => {
        if (event.type === 'host.wake_result') this.onResult(event);
      }),
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  tick(): void {
    const now = (this.o.nowMs ?? Date.now)();
    const lead = this.o.leadMs ?? DEFAULT_WAKE_LEAD_MS;
    for (const job of this.o.jobs.list()) {
      if (job.wakeHost !== true || !job.enabled || job.trigger.type !== 'cron') continue;
      const hostId = this.o.hostFor(job);
      if (hostId === null || !this.o.hostLink.isOnline(hostId)) continue;
      const next = this.o.nextRun(job.id);
      if (next === null) continue;
      const at = next.getTime() - lead;
      if (at <= now) continue;
      const key = `${hostId}:${job.id}:${at}`;
      if (this.sent.has(key)) continue;
      this.sent.add(key);
      const event: HostWakeRequestEvent = { type: 'host.wake_request', hostId, jobId: job.id, at };
      this.o.hostLink.sendTo(hostId, SURFACE_ID, event);
      this.o.logger.info({ jobId: job.id, hostId, at }, 'jobs: asked host to wake for next fire');
    }
  }

  private onResult(event: HostWakeResultEvent): void {
    if (event.ok) return;
    const job = this.o.jobs.list().find((j) => j.id === event.jobId);
    if (!job) return;
    const error = event.error ?? 'unknown error';
    this.o.logger.warn(
      { jobId: job.id, at: event.at, error },
      'jobs: host could not schedule wake',
    );
    this.o.onFailure({ job, hostId: this.o.hostFor(job), at: event.at, error });
  }
}
