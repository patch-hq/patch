// Script jobs — the host half (spec/08 § Action — `script`).
//
// A `script` job's fire arrives as `job.exec_request`: run this command, in
// this folder, on this host. There is no chat and no model anywhere in the
// path — that is the point of it, and it is why the host runs the command
// itself rather than routing it through a chat's Bash tool.
//
// The command outlives the host (spec/02 § Host restarts). It runs detached,
// in its own process group, with its output going to files rather than pipes
// the host holds, and its record is on disk before the request returns. A
// host that restarts mid-run finds the record, watches the pid it names, and
// reports the result when the command ends — the same shape as `patch_watch`
// (watch.ts). A wrapper writes the command's exit code to a sidecar file, so
// "finished while the host was down" is told apart from "died with the
// machine": the second is reported as interrupted and never re-run, because
// Patch cannot know whether a command is safe to run twice.
//
// NO FALLBACK: a folder that does not exist fails the fire and says so. It is
// never run somewhere else instead — a tick pointed at the wrong directory
// that silently ran in the host's home would report success while doing
// nothing.

import { tailCodePoints } from '@patch/wire';
import { type ChildProcess, spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { JobExecRequestEvent, WireEvent } from '@patch/wire';
import { SCRIPT_ACTION_OUTPUT_LIMIT } from '@patch/wire/jobs';
import { expandHome } from './expandHome.js';
import { defaultBootTime, defaultIsAlive, defaultProcessStart } from './watch.js';
import { inWorkSlice } from './workSlice.js';

/**
 * Bytes of each stream read back when the command ends. Only the tail is ever
 * reported, so a chatty command's output stays on disk and only its end is
 * read — it must run to completion, not be killed for its volume. Ample slack
 * over `SCRIPT_ACTION_OUTPUT_LIMIT` for trailing whitespace.
 */
const HELD_BYTES = 64 * 1024;
const DEFAULT_POLL_MS = 1_000;

/**
 * Runs the command, then records its exit code in a sidecar file. If the whole
 * group is killed (a timeout, a reboot) the wrapper dies with it and no sidecar
 * appears; that absence is how a killed run is told from a finished one.
 */
const WRAPPER = 'f="$1"; shift; "$@"; c=$?; echo $c > "$f.tmp" && mv "$f.tmp" "$f"; exit $c';

/** A script run in flight, persisted at `<runDir>/<key>.json`. */
export const JobRunRecord = z
  .object({
    jobId: z.string().min(1),
    fireId: z.string().min(1),
    folder: z.string().min(1),
    command: z.string().min(1),
    timeoutMs: z.number().int().positive(),
    startedAt: z.number().int(),
    /** The detached process-group leader (the wrapper); its pid is the pgid. */
    pid: z.number().int(),
    /** The OS's start time for `pid`, so a reused pid after a reboot is not mistaken for the run. */
    pidStart: z.string().min(1).optional(),
    /** Set once the host has killed the run for outliving its timeout. */
    timedOut: z.boolean().optional(),
  })
  .passthrough();
export type JobRunRecord = z.infer<typeof JobRunRecord>;

export interface JobRunsDeps {
  /** `<patchHome>/job-runs`. */
  runDir: string;
  /** Where results go. The server link buffers while it is offline. */
  emit(event: WireEvent): void;
  logger: Logger;
  now?(): number;
  pollMs?: number;
  isAlive?(pid: number): boolean;
  processStart?(pid: number): string | undefined;
  bootTime?(): number | undefined;
}

type ExecResult = Extract<WireEvent, { type: 'job.exec_result' }>;

/** Keep the TAIL: the interesting part of a failing command is its last words. */
function tail(s: string): string {
  const t = s.trimEnd();
  return t.length <= SCRIPT_ACTION_OUTPUT_LIMIT
    ? t
    : `…${tailCodePoints(t, SCRIPT_ACTION_OUTPUT_LIMIT)}`;
}

function readTail(path: string): string {
  let size: number;
  try {
    size = statSync(path).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
  const len = Math.min(size, HELD_BYTES);
  if (len === 0) return '';
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  return buf.toString('utf8');
}

/** A fire id as a file name: anything outside a safe set becomes `_`. */
function keyOf(fireId: string): string {
  return fireId.replace(/[^A-Za-z0-9_-]/g, '_');
}

export class JobRuns {
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly processStart: (pid: number) => string | undefined;
  private readonly bootTime: () => number | undefined;
  /** Runs this process started: their exit arrives as an event. */
  private readonly live = new Map<string, ChildProcess>();
  /** Runs a previous host started: only their pid is known, so they are polled. */
  private readonly adopted = new Set<string>();
  private readonly deadlines = new Map<string, ReturnType<typeof setTimeout>>();
  private poll: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: JobRunsDeps) {
    this.now = deps.now ?? Date.now;
    this.isAlive = deps.isAlive ?? defaultIsAlive;
    this.processStart = deps.processStart ?? defaultProcessStart;
    this.bootTime = deps.bootTime ?? defaultBootTime;
  }

  private paths(key: string): { rec: string; out: string; err: string; exit: string } {
    const base = join(this.deps.runDir, key);
    return { rec: `${base}.json`, out: `${base}.out`, err: `${base}.err`, exit: `${base}.exit` };
  }

  private write(rec: JobRunRecord): void {
    const path = this.paths(keyOf(rec.fireId)).rec;
    writeFileSync(`${path}.tmp`, JSON.stringify(rec), 'utf8');
    renameSync(`${path}.tmp`, path);
  }

  private read(key: string): JobRunRecord | undefined {
    const path = this.paths(key).rec;
    if (!existsSync(path)) return undefined;
    try {
      return JobRunRecord.parse(JSON.parse(readFileSync(path, 'utf8')));
    } catch (err) {
      // A run whose record cannot be read cannot be reported: say so and drop it,
      // so one bad file does not stop the rest being picked up.
      this.deps.logger.error({ path, err }, 'job run: unreadable record, dropping it');
      this.remove(key);
      return undefined;
    }
  }

  private remove(key: string): void {
    for (const p of Object.values(this.paths(key))) rmSync(p, { force: true });
    rmSync(`${this.paths(key).exit}.tmp`, { force: true });
  }

  /** Run one fire's command. Returns once it is started and recorded (or refused). */
  start(event: JobExecRequestEvent): void {
    const started = this.now();
    const refuse = (error: string): void =>
      this.deps.emit({
        type: 'job.exec_result',
        jobId: event.jobId,
        fireId: event.fireId,
        ok: false,
        exitCode: null,
        durationMs: Math.max(0, this.now() - started),
        stdout: '',
        stderr: '',
        error,
      });

    // Typed the way a shell accepts a path — `~/projects/x` — but this never
    // goes through a shell, so expand it before any fs call.
    const folder = expandHome(event.folder);
    if (!existsSync(folder) || !statSync(folder).isDirectory()) {
      this.deps.logger.error(
        { jobId: event.jobId, folder: event.folder },
        'job.exec_request: folder not found, refusing to run elsewhere',
      );
      refuse(`folder not found on this host: ${event.folder}`);
      return;
    }
    const key = keyOf(event.fireId);
    if (existsSync(this.paths(key).rec)) {
      // The server sent the same fire twice; one run of it is already going.
      this.deps.logger.warn(
        { jobId: event.jobId, fireId: event.fireId },
        'job.exec_request: this fire is already running, not starting it again',
      );
      return;
    }
    mkdirSync(this.deps.runDir, { recursive: true });
    const p = this.paths(key);
    this.remove(key);

    // A login shell, then the command in a plain one. Two separate needs.
    //
    // LOGIN, because the command is written by the same person who writes the
    // host's dotfiles, and a tick that works when they type it must work here —
    // the profile's PATH especially.
    //
    // But a non-interactive LOGIN shell reads `~/.bash_logout` whenever `exit` is
    // executed explicitly, and Ubuntu's default one ends in
    //
    //     [ -x /usr/bin/clear_console ] && /usr/bin/clear_console -q
    //
    // which returns 1 for want of a console — a host has none, ever. That
    // becomes the shell's exit status, so `set -euo pipefail` + `exit 0`, i.e. how
    // every careful gate is written, reported FAILURE on every correct hold
    // (caught 12 Sep 2026 the first time a gate printed a verdict and the run
    // still came back `dispatch-error`). `exec` is the fix: it replaces the login
    // shell with a plain one, so there is no login shell left to read a logout
    // file, and the status recorded is the command's own and nothing else.
    //
    // The command travels in the ENVIRONMENT rather than inside the `-c` string so
    // there is no quoting to get wrong — a gate is full of quotes and heredocs.
    const launch = inWorkSlice('/bin/bash', ['-lc', 'exec /bin/bash -c "$PATCH_JOB_COMMAND"']);
    const outFd = openSync(p.out, 'a');
    const errFd = openSync(p.err, 'a');
    let child: ChildProcess;
    try {
      child = spawn('/bin/sh', ['-c', WRAPPER, 'sh', p.exit, launch.command, ...launch.args], {
        cwd: folder,
        env: { ...process.env, PATCH_JOB_COMMAND: event.command },
        // Its own process group: the host can kill the whole run on a timeout,
        // and the host's own exit reaches none of it.
        detached: true,
        stdio: ['ignore', outFd, errFd],
      });
    } finally {
      closeSync(outFd);
      closeSync(errFd);
    }
    child.on('error', (err) => {
      this.deps.logger.warn({ jobId: event.jobId, err }, 'job.exec_request: command failed');
      // A run that never started (no pid) was never tracked; one that did is
      // reported here only if its exit has not been already.
      if (child.pid !== undefined && !this.live.delete(key)) return;
      this.clearDeadline(key);
      this.remove(key);
      refuse(`command failed: ${err.message}`);
    });
    if (child.pid === undefined) return; // the 'error' event reports it
    const pidStart = this.processStart(child.pid);
    const rec: JobRunRecord = {
      jobId: event.jobId,
      fireId: event.fireId,
      folder: event.folder,
      command: event.command,
      timeoutMs: event.timeoutMs,
      startedAt: started,
      pid: child.pid,
      ...(pidStart !== undefined ? { pidStart } : {}),
    };
    this.write(rec);
    this.live.set(key, child);
    child.on('exit', (_code, signal) => {
      if (!this.live.delete(key)) return;
      this.settle(key, signal);
    });
    this.armDeadline(rec);
    // The run is the host's work, not a reason to keep the process alive.
    child.unref();
  }

  /**
   * Host start: every run a previous host left is picked up. A finished one is
   * reported now; a running one is watched until it ends.
   */
  adopt(): number {
    if (!existsSync(this.deps.runDir)) return 0;
    let n = 0;
    for (const name of readdirSync(this.deps.runDir)) {
      if (!name.endsWith('.json')) continue;
      const key = name.slice(0, -'.json'.length);
      if (this.live.has(key) || this.adopted.has(key)) continue;
      const rec = this.read(key);
      if (!rec) continue;
      n += 1;
      this.adopted.add(key);
      this.deps.logger.info(
        { jobId: rec.jobId, fireId: rec.fireId },
        'job run: picked up a script run the previous host started',
      );
    }
    if (this.adopted.size > 0) {
      this.check();
      this.poll ??= setInterval(() => this.check(), this.deps.pollMs ?? DEFAULT_POLL_MS);
      this.poll.unref?.();
    }
    return n;
  }

  /** Stop watching. Runs keep going and are picked up by the next host. */
  dispose(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    for (const t of this.deadlines.values()) clearTimeout(t);
    this.deadlines.clear();
    for (const child of this.live.values()) child.removeAllListeners('exit');
    this.live.clear();
    this.adopted.clear();
  }

  /** Runs in flight, started here or picked up. */
  get running(): number {
    return this.live.size + this.adopted.size;
  }

  private check(): void {
    for (const key of [...this.adopted]) {
      const rec = this.read(key);
      if (!rec) {
        this.adopted.delete(key);
        continue;
      }
      if (this.isOurs(rec)) {
        if (!rec.timedOut && this.now() - rec.startedAt > rec.timeoutMs) this.timeOut(rec);
        continue;
      }
      this.adopted.delete(key);
      this.settle(key, null);
    }
    if (this.adopted.size === 0 && this.poll) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
  }

  private isOurs(rec: JobRunRecord): boolean {
    if (!this.isAlive(rec.pid)) return false;
    return rec.pidStart === undefined || this.processStart(rec.pid) === rec.pidStart;
  }

  private armDeadline(rec: JobRunRecord): void {
    const key = keyOf(rec.fireId);
    const left = rec.startedAt + rec.timeoutMs - this.now();
    const t = setTimeout(() => this.timeOut(rec), Math.max(0, left));
    t.unref?.();
    this.deadlines.set(key, t);
  }

  private clearDeadline(key: string): void {
    const t = this.deadlines.get(key);
    if (t) clearTimeout(t);
    this.deadlines.delete(key);
  }

  /** Kill the run's whole group, marking it timed out first so the next host knows why it died. */
  private timeOut(rec: JobRunRecord): void {
    const key = keyOf(rec.fireId);
    this.deadlines.delete(key);
    const child = this.live.get(key);
    const alive = child ? child.exitCode === null && child.signalCode === null : this.isOurs(rec);
    if (!alive) return;
    this.write({ ...rec, timedOut: true });
    try {
      process.kill(-rec.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }

  /** The run has ended: report it once and forget it. */
  private settle(key: string, signal: NodeJS.Signals | null): void {
    this.clearDeadline(key);
    const rec = this.read(key);
    if (!rec) return;
    const p = this.paths(key);
    const stdout = readTail(p.out);
    const stderr = readTail(p.err);
    const sidecar = existsSync(p.exit) ? Number.parseInt(readFileSync(p.exit, 'utf8'), 10) : NaN;
    const exitCode = Number.isNaN(sidecar) ? null : sidecar;
    let error: string | undefined;
    if (rec.timedOut) error = `command killed after its ${rec.timeoutMs}ms timeout`;
    else if (exitCode !== null && exitCode !== 0) error = `command failed: exit code ${exitCode}`;
    else if (exitCode === null)
      error =
        signal !== null
          ? `command failed: killed by ${signal}`
          : `interrupted: ${this.cause(rec)} while the command was running, so it was cut off and has not been re-run`;
    const ok = error === undefined;
    if (!ok)
      this.deps.logger.warn(
        { jobId: rec.jobId, fireId: rec.fireId, exitCode, err: error },
        'job.exec_request: command failed',
      );
    const result: ExecResult = {
      type: 'job.exec_result',
      jobId: rec.jobId,
      fireId: rec.fireId,
      ok,
      exitCode: rec.timedOut ? null : exitCode,
      durationMs: Math.max(0, this.now() - rec.startedAt),
      stdout: tail(stdout),
      stderr: tail(stderr),
      ...(error !== undefined ? { error } : {}),
    };
    this.deps.emit(result);
    this.remove(key);
  }

  private cause(rec: JobRunRecord): string {
    const boot = this.bootTime();
    if (boot !== undefined && boot > rec.startedAt)
      return process.platform === 'darwin' ? 'the Mac restarted' : 'the machine restarted';
    return 'its process was killed while the host was down';
  }
}
