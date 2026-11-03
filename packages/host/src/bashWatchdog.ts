import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Bash time limits that actually bind.
 *
 * Claude Code enforces a Bash call's `timeout` itself, but only by signalling
 * the shell it started. A command stuck in an uninterruptible wait (macOS
 * privacy prompts on ~/Documents, a dead network mount) ignores that, the
 * tool call never returns, and everything queued behind it waits forever.
 *
 * The host sees every Bash tool_use and its result, so it keeps the limit
 * itself: once a call is past its timeout plus a grace, it finds the process
 * groups the call started under claude, sends SIGTERM, then SIGKILL, and
 * says so in the chat. A group that survives both is abandoned out loud.
 */

export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const MAX_BASH_TIMEOUT_MS = 600_000;
/** Claude's own timeout handling gets this long to work before the host steps in. */
export const GRACE_MS = 10_000;
/** SIGTERM to SIGKILL. */
export const TERM_WAIT_MS = 5_000;
/** SIGKILL to giving up. */
export const KILL_WAIT_MS = 5_000;

export interface ProcRow {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
}

export interface WatchdogDeps {
  /** claude's pid, once known. */
  rootPid: () => number | undefined;
  list: () => Promise<ProcRow[]>;
  /** Send `signal` to the group `pgid`; false if no such group. */
  killGroup: (pgid: number, signal: NodeJS.Signals) => boolean;
  /** Tell the chat. */
  announce: (message: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

interface Call {
  command: string;
  timeoutMs: number;
  /** Process groups under claude that were there before the call started. */
  before: Set<number>;
  timer: unknown;
}

const run = promisify(execFile);

export async function listProcesses(): Promise<ProcRow[]> {
  const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=,pgid=,command='], {
    maxBuffer: 32 * 1024 * 1024,
  });
  const rows: ProcRow[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4]! });
  }
  return rows;
}

export function killProcessGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // EPERM on macOS is what a group made only of dying processes answers.
    if (code === 'ESRCH' || code === 'EPERM') return false;
    throw e;
  }
}

/** The effective limit of a Bash call, as Claude Code applies it. */
export function bashTimeoutMs(input: unknown): number {
  const raw =
    typeof input === 'object' && input !== null
      ? (input as Record<string, unknown>)['timeout']
      : undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_BASH_TIMEOUT_MS;
  return Math.min(raw, MAX_BASH_TIMEOUT_MS);
}

/** Every process below `root`, grouped by process group. */
export function groupsUnder(rows: ProcRow[], root: number): Map<number, ProcRow[]> {
  const children = new Map<number, ProcRow[]>();
  for (const r of rows) {
    const list = children.get(r.ppid);
    if (list) list.push(r);
    else children.set(r.ppid, [r]);
  }
  const rootGroup = rows.find((r) => r.pid === root)?.pgid ?? root;
  const groups = new Map<number, ProcRow[]>();
  const stack = [root];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const c of children.get(pid) ?? []) {
      stack.push(c.pid);
      // Claude's own group also holds its MCP servers; never touched.
      if (c.pgid === rootGroup) continue;
      const g = groups.get(c.pgid);
      if (g) g.push(c);
      else groups.set(c.pgid, [c]);
    }
  }
  return groups;
}

export class BashWatchdog {
  private readonly calls = new Map<string, Call>();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly deps: WatchdogDeps) {
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref();
        return t;
      });
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  /** A Bash call has started. Background calls are not watched: they are meant to outlive it. */
  async started(callId: string, input: unknown): Promise<void> {
    const args = (typeof input === 'object' && input !== null ? input : {}) as Record<
      string,
      unknown
    >;
    if (args['run_in_background'] === true) return;
    const timeoutMs = bashTimeoutMs(input);
    const command = typeof args['command'] === 'string' ? args['command'] : '';
    const call: Call = { command, timeoutMs, before: new Set(), timer: undefined };
    this.calls.set(callId, call);
    call.timer = this.setTimer(() => void this.expired(callId), timeoutMs + GRACE_MS);
    const root = this.deps.rootPid();
    if (root === undefined) return;
    try {
      call.before = new Set(groupsUnder(await this.deps.list(), root).keys());
    } catch (e) {
      this.deps.announce(`Bash watchdog could not list processes: ${(e as Error).message}`);
    }
  }

  /** The call returned (or the turn ended). */
  finished(callId: string): void {
    const call = this.calls.get(callId);
    if (!call) return;
    this.clearTimer(call.timer);
    this.calls.delete(callId);
  }

  stop(): void {
    for (const id of [...this.calls.keys()]) this.finished(id);
  }

  private async expired(callId: string): Promise<void> {
    const call = this.calls.get(callId);
    if (!call) return;
    const secs = Math.round(call.timeoutMs / 1000);
    const root = this.deps.rootPid();
    if (root === undefined) {
      this.deps.announce(
        `A Bash command ran past its ${secs}s limit and the host could not find the Claude process to stop it.`,
      );
      return;
    }
    let victims: number[];
    try {
      victims = this.victims(call, await this.deps.list(), root);
    } catch (e) {
      this.deps.announce(
        `A Bash command ran past its ${secs}s limit; listing processes failed: ${(e as Error).message}`,
      );
      return;
    }
    if (!this.calls.has(callId)) return; // it returned while we looked
    if (victims.length === 0) {
      this.deps.announce(
        `A Bash command ran past its ${secs}s limit but no process of it could be identified to stop.`,
      );
      return;
    }
    this.deps.announce(`A Bash command ran past its ${secs}s limit; stopping it.`);
    for (const g of victims) this.deps.killGroup(g, 'SIGTERM');
    await this.wait(TERM_WAIT_MS);
    if (!this.calls.has(callId)) return;
    for (const g of victims) this.deps.killGroup(g, 'SIGKILL');
    await this.wait(KILL_WAIT_MS);
    if (!this.calls.has(callId)) return;
    const left = this.victims(call, await this.deps.list(), root).filter((g) =>
      victims.includes(g),
    );
    this.calls.delete(callId);
    this.deps.announce(
      left.length > 0
        ? `A Bash command past its ${secs}s limit would not die (process group ${left.join(', ')}, stuck even after SIGKILL). The host has abandoned it; it may still be running.`
        : `A Bash command past its ${secs}s limit was killed but never reported back; the host has abandoned it.`,
    );
  }

  /**
   * The groups the call started: new since it began, under claude. With
   * several calls in flight, a group is attributed by the command text it
   * carries; one that matches no call goes to the sole call in flight.
   */
  private victims(call: Call, rows: ProcRow[], root: number): number[] {
    const fresh = [...groupsUnder(rows, root)].filter(([g]) => !call.before.has(g));
    const snippet = call.command.split('\n')[0]!.trim().slice(0, 60);
    if (snippet.length > 0) {
      const matched = fresh.filter(([, procs]) => procs.some((p) => p.command.includes(snippet)));
      if (matched.length > 0) return matched.map(([g]) => g);
    }
    return this.calls.size <= 1 ? fresh.map(([g]) => g) : [];
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => void this.setTimer(resolve, ms));
  }
}
