// Update probation: a freshly installed host is only kept once it has proved
// itself (spec/02 § Installation).
//
// Before an update's installer runs, `applyUpdate` writes `update-probation.json`
// and starts a watchdog — a SEPARATE process running the OLD, known-good
// build. A host that crash-loops at import (the 1.1.1593 Mac outage: a dangling
// onnxruntime symlink) can never roll itself back, so the judge has to live
// outside it.
//
// The new host, once connected to the server, keeps `update-probation.alive.json`
// fresh. The watchdog commits (deletes the probation) when that host has stayed
// connected for `stableMs`; if it has not by `deadlineMs` it re-runs the previous
// version's own installer — which repoints `current`, re-registers the unit and
// restarts the service — and leaves `update-failed.json` for the old host to
// report to the server when it reconnects.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** CLI flag that makes host.mjs run the watchdog instead of the host. */
export const WATCHDOG_FLAG = '--update-watchdog';

export const PROBATION_STABLE_MS = 60_000;
export const PROBATION_DEADLINE_MS = 5 * 60_000;
const POLL_MS = 5_000;
/** The heartbeat is written every 10s; older than this means the host is gone. */
const ALIVE_FRESH_MS = 30_000;

export interface Probation {
  from: string;
  to: string;
  startedAt: number;
  /** The previous version's installer, run to roll back. */
  rollbackInstaller: string;
  serverUrl: string;
}

export interface Alive {
  version: string;
  pid: number;
  since: number;
  at: number;
}

export interface UpdateFailure {
  from: string;
  to: string;
  reason: string;
  at: string;
}

const probationPath = (home: string): string => join(home, 'update-probation.json');
const alivePath = (home: string): string => join(home, 'update-probation.alive.json');
const failurePath = (home: string): string => join(home, 'update-failed.json');

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** A missing file is `undefined`; an unreadable one throws — never silently "no probation". */
function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function writeProbation(home: string, p: Probation): void {
  rmSync(alivePath(home), { force: true });
  writeAtomic(probationPath(home), JSON.stringify(p));
}

export function readProbation(home: string): Probation | undefined {
  return readJson<Probation>(probationPath(home));
}

export function clearProbation(home: string): void {
  rmSync(probationPath(home), { force: true });
  rmSync(alivePath(home), { force: true });
}

/**
 * Called by a host that is connected to the server. Only writes when this very
 * version is the one on probation; `since` survives across calls from the same
 * process, so an unbroken connection reads as one long stretch.
 */
export function recordAlive(home: string, version: string, now: number = Date.now()): boolean {
  const probation = readProbation(home);
  if (!probation || probation.to !== version) return false;
  const prior = readJson<Alive>(alivePath(home));
  const since = prior && prior.pid === process.pid && prior.version === version ? prior.since : now;
  writeAtomic(alivePath(home), JSON.stringify({ version, pid: process.pid, since, at: now }));
  return true;
}

/** A recorded rollback, handed over once: read and removed. */
export function takeUpdateFailure(home: string): UpdateFailure | undefined {
  const failure = readJson<UpdateFailure>(failurePath(home));
  if (failure) rmSync(failurePath(home), { force: true });
  return failure;
}

export type ProbationVerdict = 'committed' | 'rolled-back' | 'no-probation';

export interface WatchdogDeps {
  home: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Run the previous version's installer. Rejects when it fails. */
  rollback?: (p: Probation) => Promise<void>;
  /** The version `current` points at after the rollback. */
  installedVersion: () => string | undefined;
  log: (line: string) => void;
  stableMs?: number;
  deadlineMs?: number;
}

/** Judge the update on probation: commit it, or roll back to the previous version. */
export async function runWatchdog(deps: WatchdogDeps): Promise<ProbationVerdict> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const stableMs = deps.stableMs ?? PROBATION_STABLE_MS;
  const deadlineMs = deps.deadlineMs ?? PROBATION_DEADLINE_MS;
  const probation = readProbation(deps.home);
  if (!probation) return 'no-probation';
  deps.log(`watching ${probation.from} → ${probation.to}`);

  let lastSeen = 'the new host never connected to the server';
  for (;;) {
    // Cleared from outside (the installer failed outright, so nothing is on probation).
    if (!readProbation(deps.home)) return 'no-probation';
    const alive = readJson<Alive>(alivePath(deps.home));
    const t = now();
    if (alive && alive.version === probation.to) {
      if (t - alive.at > ALIVE_FRESH_MS) {
        lastSeen = `the new host connected but then went silent for ${Math.round((t - alive.at) / 1000)}s`;
      } else if (alive.at - alive.since >= stableMs) {
        clearProbation(deps.home);
        deps.log(`${probation.to} stayed up ${Math.round(stableMs / 1000)}s — committed`);
        return 'committed';
      } else {
        lastSeen = 'the new host connected but did not stay up long enough';
      }
    }
    if (t - probation.startedAt >= deadlineMs) break;
    await sleep(POLL_MS);
  }

  const reason = `${probation.to} was not healthy within ${Math.round(deadlineMs / 1000)}s: ${lastSeen}`;
  deps.log(`${reason} — rolling back to ${probation.from}`);
  const rollback = deps.rollback ?? defaultRollback;
  let failure = reason;
  try {
    await rollback(probation);
    const now2 = deps.installedVersion();
    if (now2 !== probation.from) {
      failure += `; rollback ran but this host is on ${now2 ?? 'an unknown version'}, not ${probation.from}`;
    }
  } catch (err) {
    failure += `; ROLLBACK FAILED: ${(err as Error).message}`;
  }
  const record: UpdateFailure = {
    from: probation.from,
    to: probation.to,
    reason: failure,
    at: new Date(now()).toISOString(),
  };
  writeAtomic(failurePath(deps.home), JSON.stringify(record));
  clearProbation(deps.home);
  deps.log(failure);
  return 'rolled-back';
}

/** The previous build's own installer; it reads the server secret from machine settings. */
function defaultRollback(p: Probation): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(p.rollbackInstaller, ['--non-interactive', '--server', p.serverUrl], {
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`installer exited ${code ?? signal}`)),
    );
  });
}

/**
 * Start the watchdog from the running (old, good) build, in its own session so
 * the installer's service restart does not take it down with the host.
 */
export function spawnWatchdog(opts: {
  nodePath: string;
  programPath: string;
  logFd: number;
}): void {
  const child = spawn(opts.nodePath, [opts.programPath, WATCHDOG_FLAG], {
    detached: true,
    stdio: ['ignore', opts.logFd, opts.logFd],
  });
  child.unref();
}

/** The `current` symlink's version, for a watchdog process. */
export function currentVersionOf(
  home: string,
  readlink: (p: string) => string,
): string | undefined {
  try {
    return basename(readlink(join(home, 'current')));
  } catch {
    return undefined;
  }
}
