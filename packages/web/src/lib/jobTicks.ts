// Scheduled-job ticks for a chat (spec/14 § Main chat panel — Job tick bar).
//
// A chat a recurring job keeps re-prompting is effectively a loop, so its bar is
// persistent. The header chip and the bar both read the same per-chat entry, so
// one fetch + poll serves both; it runs only while something is subscribed.

import { useCallback, useSyncExternalStore } from 'react';
import { describeRecurrence } from '@patch/wire';
import type { ChatJobTick } from '@patch/wire/jobs';
import { api } from '../api/rest.js';
import { formatEvery, formatWakeCountdown } from '../components/WakeBar.js';

export interface JobTickState {
  jobs: ChatJobTick[];
  error: string | null;
  loaded: boolean;
}

const POLL_MS = 30_000;
const EMPTY: JobTickState = { jobs: [], error: null, loaded: false };

interface Entry {
  state: JobTickState;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
}
const entries = new Map<string, Entry>();

function publish(e: Entry, state: JobTickState): void {
  e.state = state;
  for (const l of e.listeners) l();
}

/** Refetch a chat's ticks now (also called when a countdown reaches zero). */
export function refreshJobTicks(chatId: string): void {
  const e = entries.get(chatId);
  if (!e) return;
  // Via a promise so a call that throws synchronously is a load error, not a crash.
  Promise.resolve()
    .then(() => api.chatJobTicks(chatId))
    .then((r) => publish(e, { jobs: r.jobs, error: null, loaded: true }))
    .catch((err: Error) => publish(e, { jobs: [], error: err.message, loaded: true }));
}

function subscribe(chatId: string, listener: () => void): () => void {
  let e = entries.get(chatId);
  if (!e) {
    e = { state: EMPTY, listeners: new Set(), timer: null };
    entries.set(chatId, e);
  }
  e.listeners.add(listener);
  if (e.listeners.size === 1) {
    refreshJobTicks(chatId);
    e.timer = setInterval(() => refreshJobTicks(chatId), POLL_MS);
  }
  return () => {
    e.listeners.delete(listener);
    if (e.listeners.size === 0) {
      if (e.timer) clearInterval(e.timer);
      entries.delete(chatId);
    }
  };
}

export function useChatJobTicks(chatId: string): JobTickState {
  // Stable per chat: a new function each render would resubscribe, refetch and loop.
  const sub = useCallback((l: () => void) => subscribe(chatId, l), [chatId]);
  return useSyncExternalStore(sub, () => entries.get(chatId)?.state ?? EMPTY);
}

/** `2m 14s`, `9m`, `3h 4m` — the wait until `fireAt`, or `now` once it is due. */
export function tickCountdown(fireAt: number, now: number): string {
  return formatWakeCountdown(fireAt - now).replace(/^in /, '');
}

/** The job's cadence in words: `every 5m` for the common cron shapes, else the schedule itself. */
export function tickSchedule(job: ChatJobTick): string {
  if (job.trigger === 'recurrence') return describeRecurrence(job.schedule);
  const m = /^\*\/(\d+) \* \* \* \*$/.exec(job.schedule);
  if (m) return `every ${formatEvery(Number(m[1]) * 60_000)}`;
  const h = /^0 \*\/(\d+) \* \* \*$/.exec(job.schedule);
  if (h) return `every ${formatEvery(Number(h[1]) * 3_600_000)}`;
  return job.schedule;
}

/** 0..1 of the way from the previous fire to the next, null when the period is unknown. */
export function tickProgress(job: ChatJobTick, now: number): number | null {
  if (job.nextFireAt === null || job.periodMs === null || job.periodMs <= 0) return null;
  return Math.min(1, Math.max(0, 1 - (job.nextFireAt - now) / job.periodMs));
}

/** The job that fires soonest — the one the header chip counts down to. */
export function soonestTick(jobs: ChatJobTick[]): ChatJobTick | null {
  let best: ChatJobTick | null = null;
  for (const j of jobs) {
    if (j.nextFireAt === null) continue;
    if (best === null || j.nextFireAt < (best.nextFireAt ?? Infinity)) best = j;
  }
  return best;
}
