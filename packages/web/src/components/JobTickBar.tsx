// JobTickBar — the persistent bar under the chat header for a chat that
// scheduled jobs re-prompt (spec/14 § Main chat panel — Job tick bar). Same look
// as the WakeBar it stacks with: job name, cadence, a live countdown to the next
// fire, and a thin progress line. It shows the whole time, waiting between ticks.
// Both the bar and the header chip sit at the top; nothing goes above the composer.

import { useEffect, useState, type JSX } from 'react';
import { CalendarClock } from 'lucide-react';
import {
  refreshJobTicks,
  soonestTick,
  tickCountdown,
  tickProgress,
  tickSchedule,
  useChatJobTicks,
} from '../lib/jobTicks.js';

/** A wall-clock `now` that ticks every second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** Ask for fresh times a moment after the soonest fire, so the next tick replaces a spent one. */
function useRefreshAfterFire(chatId: string, fireAt: number | null, now: number): void {
  const due = fireAt !== null && now >= fireAt;
  useEffect(() => {
    if (!due) return;
    const t = setTimeout(() => refreshJobTicks(chatId), 1500);
    return () => clearTimeout(t);
  }, [chatId, due, fireAt]);
}

export function JobTickBar({ chatId }: { chatId: string }): JSX.Element | null {
  const { jobs, error } = useChatJobTicks(chatId);
  const soonest = soonestTick(jobs);
  const now = useNow(jobs.length > 0);
  useRefreshAfterFire(chatId, soonest?.nextFireAt ?? null, now);

  if (error !== null) {
    return (
      <div className="wake-bar job-tick-bar" data-testid="job-tick-bar-error" role="status">
        <span className="wake-bar-label">Failed to load scheduled jobs: {error}</span>
      </div>
    );
  }
  if (jobs.length === 0) return null;

  return (
    <div className="job-tick-bars" data-testid="job-tick-bars">
      {jobs.map((job) => {
        const progress = tickProgress(job, now);
        return (
          <div
            key={job.jobId}
            className="wake-bar job-tick-bar"
            data-testid="job-tick-bar"
            role="status"
          >
            <CalendarClock size={14} aria-hidden />
            <span className="job-tick-name" data-testid="job-tick-name" title={job.name}>
              {job.name}
            </span>
            <span className="job-tick-schedule" data-testid="job-tick-schedule">
              {tickSchedule(job)}
            </span>
            <span className="job-tick-countdown" data-testid="job-tick-countdown">
              {job.nextFireAt === null
                ? 'no next run'
                : `next ${tickCountdown(job.nextFireAt, now)}`}
            </span>
            {progress !== null ? (
              <span className="job-tick-progress" aria-hidden>
                <i data-testid="job-tick-progress" style={{ width: `${progress * 100}%` }} />
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** The header chip: `Job · next 2m 14s`, counting down to the soonest job. */
export function JobTickChip({ chatId }: { chatId: string }): JSX.Element | null {
  const { jobs } = useChatJobTicks(chatId);
  const soonest = soonestTick(jobs);
  const now = useNow(soonest !== null);
  if (soonest === null || soonest.nextFireAt === null) return null;
  return (
    <span className="job-tick-chip" data-testid="job-tick-chip">
      Job · next {tickCountdown(soonest.nextFireAt, now)}
    </span>
  );
}
