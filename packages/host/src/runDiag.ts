// Why did this host start, and why did the last one stop?
//
// A host that restarts 15 times in four minutes during a self-update left logs
// that could not say what stopped it or why the update failed. This keeps a
// small record of each run — written when it starts, amended when it is asked
// to stop — so the NEXT start can say, in daemon.log, whether it is a first
// boot, a restart after an update, or a restart after a signal or a crash.
// Local logs only: nothing here alerts or notifies.
//
// The record is re-derivable, so a corrupt or unreadable one is logged by the
// caller and treated as "no previous run known" — it never stops the host.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface ShutdownRecord {
  /** Signal name, or 'control-stop' for POST /stop. */
  via: string;
  /** Who/what asked, as far as it is knowable from inside the process. */
  caller: string;
  at: string;
}

export interface RunRecord {
  pid: number;
  version: string;
  startedAt: string;
  shutdown?: ShutdownRecord;
}

export type StartKind =
  | 'first-boot'
  | 'restart-after-update'
  | 'restart-after-stop-request'
  | 'restart-after-signal'
  | 'restart-after-unrecorded-exit';

export interface StartReason {
  kind: StartKind;
  previous?: RunRecord;
  previousExit: string;
}

/** More starts than this inside the window is a restart storm worth summarising. */
export const RESTART_STORM_COUNT = 3;
export const RESTART_STORM_WINDOW_MS = 60_000;
const MAX_START_HISTORY = 50;

const runStatePath = (patchHome: string): string => join(patchHome, 'run-state.json');
const startsPath = (patchHome: string): string => join(patchHome, 'run-starts.json');

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Classify this start from the previous run's record. Pure. */
export function classifyStart(previous: RunRecord | undefined, version: string): StartReason {
  if (!previous) return { kind: 'first-boot', previousExit: 'no previous run recorded' };
  const exit = previous.shutdown
    ? `pid ${previous.pid} (${previous.version}) was asked to stop at ${previous.shutdown.at} via ${previous.shutdown.via}; ${previous.shutdown.caller}`
    : `pid ${previous.pid} (${previous.version}) left no shutdown record — killed with SIGKILL, crashed, or the machine went down`;
  if (previous.version !== version) {
    return { kind: 'restart-after-update', previous, previousExit: exit };
  }
  if (!previous.shutdown)
    return { kind: 'restart-after-unrecorded-exit', previous, previousExit: exit };
  return {
    kind:
      previous.shutdown.via === 'control-stop'
        ? 'restart-after-stop-request'
        : 'restart-after-signal',
    previous,
    previousExit: exit,
  };
}

/** Starts inside the window ending at `now`. Pure. */
export function restartStorm(
  starts: number[],
  now: number,
): { count: number; windowMs: number; intervalsMs: number[] } | undefined {
  const recent = starts.filter((t) => now - t <= RESTART_STORM_WINDOW_MS).sort((a, b) => a - b);
  if (recent.length <= RESTART_STORM_COUNT) return undefined;
  return {
    count: recent.length,
    windowMs: RESTART_STORM_WINDOW_MS,
    intervalsMs: recent.slice(1).map((t, i) => t - recent[i]!),
  };
}

/**
 * Record this start and say why it happened. Reads the previous run's record,
 * writes this run's, and appends to the start history.
 */
export function recordStart(
  patchHome: string,
  version: string,
  now: number = Date.now(),
): { reason: StartReason; storm: ReturnType<typeof restartStorm> } {
  const previous = readJson<RunRecord>(runStatePath(patchHome));
  const reason = classifyStart(previous, version);
  writeAtomic(
    runStatePath(patchHome),
    JSON.stringify({
      pid: process.pid,
      version,
      startedAt: new Date(now).toISOString(),
    } satisfies RunRecord),
  );
  const starts = [...(readJson<number[]>(startsPath(patchHome)) ?? []), now].slice(
    -MAX_START_HISTORY,
  );
  writeAtomic(startsPath(patchHome), JSON.stringify(starts));
  return { reason, storm: restartStorm(starts, now) };
}

/** Amend this run's record with the stop request. First request wins. */
export function recordShutdown(patchHome: string, shutdown: Omit<ShutdownRecord, 'at'>): void {
  const current = readJson<RunRecord>(runStatePath(patchHome));
  if (!current || current.pid !== process.pid || current.shutdown) return;
  writeAtomic(
    runStatePath(patchHome),
    JSON.stringify({ ...current, shutdown: { ...shutdown, at: new Date().toISOString() } }),
  );
}

/**
 * What can be said about who sent a signal. Node reports the signal, never the
 * sender, so this gathers the surrounding facts instead: the parent, whether an
 * installer is running (a self-update's launchctl bootout is the usual cause),
 * and the process table's installer/launchctl entries.
 */
export function signalContext(): Record<string, unknown> {
  const ctx: Record<string, unknown> = {
    pid: process.pid,
    ppid: process.ppid,
    uptimeSec: Math.round(process.uptime()),
    senderNote: 'Node does not expose the sending pid; see installers/launchctl below',
  };
  try {
    const ps = execFileSync('ps', ['-axo', 'pid=,ppid=,etime=,command='], {
      encoding: 'utf8',
      timeout: 2000,
    });
    ctx.relatedProcesses = ps
      .split('\n')
      .filter(
        (l) => /\/install\b|install\.mjs|launchctl|systemctl/.test(l) && !/\bps -axo\b/.test(l),
      )
      .map((l) => l.trim().replace(/--internal-token\s+\S+/g, '--internal-token <redacted>'))
      .slice(0, 10);
  } catch (err) {
    ctx.relatedProcessesError = (err as Error).message;
  }
  return ctx;
}

/** How many times an install of `version` has been started on this machine, this one included. */
export function countUpdateAttempt(patchHome: string, version: string): number {
  const path = join(patchHome, 'update-attempts.json');
  let prior: { version: string; count: number } | undefined;
  try {
    prior = readJson<{ version: string; count: number }>(path);
  } catch {
    prior = undefined;
  }
  const count = prior?.version === version ? prior.count + 1 : 1;
  writeAtomic(path, JSON.stringify({ version, count }));
  return count;
}
