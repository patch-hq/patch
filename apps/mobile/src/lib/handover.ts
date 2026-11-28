// Handover on the phone (spec/05 § Handover): what survives between runs and
// what the user can read back.
//
// - `last`: the newest position this phone knows of from another surface, and
//   whether it has been applied. A silent push stores it here even when the app
//   is not running, so a cold start opens straight onto it.
// - `handledAt`: the server stamp of the newest position applied, dropped or
//   authored here. Persisted so a restart does not re-apply an old move.
// - the decision log: the last LOG_LIMIT decisions, for Settings → Handover.
// - pushes today: how often the phone was woken for a handover.
//
// The background task is defined at module load (from the app entry), as
// expo-task-manager requires, so it exists before any push can arrive.

import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { ViewPage } from '@patch/wire';
import { store } from './credential';

export const HANDOVER_TASK = 'patch-handover-push';
const LAST_KEY = 'patch.handover.last';
const HANDLED_KEY = 'patch.handover.handledAt';
const LOG_KEY = 'patch.handover.log';
const PUSHES_KEY = 'patch.handover.pushes';
const ENABLED_KEY = 'patch.handover.enabled';
const TASK_ERROR_KEY = 'patch.handover.taskError';
export const LOG_LIMIT = 30;

export interface HandoverPosition {
  page: ViewPage;
  id?: string;
  seq?: number;
  surfaceId: string;
  surfaceKind?: string;
  /** Server stamp. */
  updatedAt: number;
}

export type HandoverVia = 'push' | 'socket' | 'launch';
export type HandoverOutcome = 'applied' | 'offered' | 'dropped' | 'stored';

export interface HandoverLogEntry {
  at: number;
  via: HandoverVia;
  outcome: HandoverOutcome;
  /** "chat 01M8… at 3357", "jobs" */
  where: string;
  from: string;
  why: string;
}

function readJson<T>(key: string): T | null {
  const raw = store().getString(key);
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    // Re-derivable: the next position replaces it. Say so and start clean.
    console.warn(`[patch] handover: unreadable ${key}, discarded`, err);
    store().delete(key);
    return null;
  }
}

export function readLast(): HandoverPosition | null {
  return readJson<HandoverPosition>(LAST_KEY);
}

export function writeLast(p: HandoverPosition): void {
  const cur = readLast();
  if (cur && cur.updatedAt >= p.updatedAt) return;
  store().set(LAST_KEY, JSON.stringify(p));
}

export function readHandledAt(): number {
  return store().getNumber(HANDLED_KEY) ?? 0;
}

export function writeHandledAt(updatedAt: number): void {
  if (updatedAt > readHandledAt()) store().set(HANDLED_KEY, updatedAt);
}

/** "Sync position between surfaces", as last loaded; null until it ever has been. */
export function readSyncEnabled(): boolean | null {
  const v = store().getBoolean(ENABLED_KEY);
  return v === undefined ? null : v;
}

export function writeSyncEnabled(on: boolean): void {
  store().set(ENABLED_KEY, on);
}

/** The same words the call pill uses for another device (RemoteCallPill). */
export function surfaceName(kind: string | undefined): string {
  switch (kind) {
    case 'desktop':
      return 'your computer';
    case 'web':
      return 'your browser';
    case 'mobile':
      return 'another phone';
    default:
      return 'another device';
  }
}

export function describeWhere(p: { page: ViewPage; id?: string; seq?: number }): string {
  const id = p.id === undefined ? '' : ` ${p.id.slice(0, 10)}`;
  const seq = p.seq === undefined ? '' : ` at ${String(p.seq)}`;
  return `${p.page}${id}${seq}`;
}

export function readLog(): HandoverLogEntry[] {
  return readJson<HandoverLogEntry[]>(LOG_KEY) ?? [];
}

export function logDecision(
  p: HandoverPosition,
  via: HandoverVia,
  outcome: HandoverOutcome,
  why: string,
  now: number = Date.now(),
): void {
  const entry: HandoverLogEntry = {
    at: now,
    via,
    outcome,
    where: describeWhere(p),
    from: surfaceName(p.surfaceKind),
    why,
  };
  store().set(LOG_KEY, JSON.stringify([entry, ...readLog()].slice(0, LOG_LIMIT)));
}

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function pushesToday(now: number = Date.now()): number {
  const v = readJson<{ day: string; count: number }>(PUSHES_KEY);
  return v && v.day === today(now) ? v.count : 0;
}

function countPush(now: number): void {
  store().set(PUSHES_KEY, JSON.stringify({ day: today(now), count: pushesToday(now) + 1 }));
}

/** A push's data as a position; null when it is not a handover push or is malformed. */
export function positionFromPush(data: unknown): HandoverPosition | null {
  if (data === null || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d['kind'] !== 'view_position') return null;
  const page = ViewPage.safeParse(d['page']);
  const updatedAt = Number(d['updatedAt']);
  const surfaceId = d['surfaceId'];
  if (!page.success || !Number.isFinite(updatedAt) || typeof surfaceId !== 'string') {
    console.warn('[patch] handover: malformed push', d);
    return null;
  }
  const seq = d['seq'] === undefined ? undefined : Number(d['seq']);
  return {
    page: page.data,
    ...(typeof d['id'] === 'string' ? { id: d['id'] } : {}),
    ...(seq !== undefined && Number.isInteger(seq) ? { seq } : {}),
    surfaceId,
    ...(typeof d['surfaceKind'] === 'string' ? { surfaceKind: d['surfaceKind'] } : {}),
    updatedAt,
  };
}

/** Called with each handover push while the app's UI is alive (ViewPositionSync). */
let liveListener: ((p: HandoverPosition) => void) | null = null;
export function setHandoverPushListener(l: ((p: HandoverPosition) => void) | null): void {
  liveListener = l;
}

/** A handover push arrived (background task, or the foreground listener). */
export function receiveHandoverPush(data: unknown, now: number = Date.now()): void {
  const p = positionFromPush(data);
  if (!p) return;
  countPush(now);
  if (p.updatedAt <= readHandledAt()) {
    logDecision(p, 'push', 'dropped', 'already applied or newer seen', now);
    return;
  }
  writeLast(p);
  if (liveListener) {
    liveListener(p);
    return;
  }
  logDecision(p, 'push', 'stored', 'app not running: opens there on launch', now);
}

/** Expo hands a data-only push to the task as `{ data }` with the payload under `data.body` or `data` itself. */
export function pushPayload(taskData: unknown): unknown {
  const d = (taskData as { data?: unknown } | null)?.data ?? taskData;
  if (d && typeof d === 'object') {
    const body = (d as Record<string, unknown>)['body'];
    if (typeof body === 'string') {
      try {
        return JSON.parse(body) as unknown;
      } catch {
        return d;
      }
    }
    const dataString = (d as Record<string, unknown>)['dataString'];
    if (typeof dataString === 'string') {
      try {
        return JSON.parse(dataString) as unknown;
      } catch {
        return d;
      }
    }
  }
  return d;
}

/** Define the background task and register it with expo-notifications. Called once, from the entry. */
export function defineHandoverTask(): void {
  TaskManager.defineTask(HANDOVER_TASK, ({ data, error }) => {
    if (error) {
      console.warn('[patch] handover task error', error);
      return Promise.resolve();
    }
    receiveHandoverPush(pushPayload(data));
    return Promise.resolve();
  });
  Notifications.registerTaskAsync(HANDOVER_TASK)
    .then(() => store().delete(TASK_ERROR_KEY))
    .catch((err: unknown) => {
      // Shown in Settings → Handover: without the task a put-away phone never moves.
      const msg = err instanceof Error ? err.message : String(err);
      store().set(TASK_ERROR_KEY, msg);
      console.warn('[patch] handover: could not register the background push task', err);
    });
}

/** Why the background push task could not be registered, or null when it is. */
export function readTaskError(): string | null {
  return store().getString(TASK_ERROR_KEY) ?? null;
}
