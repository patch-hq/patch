// Processes a chat started that outlived the command that started them
// (spec/02 § Stray processes). `nohup long-thing &` inside a plain Bash call is
// neither a `patch_watch` task nor a refused `run_in_background`: the shell
// exits, the process is reparented to init and, until now, nothing in Patch
// knew it existed.
//
// The handle is the environment. Every process of a chat's turn inherits
// `PATCH_CHAT_ID` (sdkBackend.ts `buildSdkEnv`), and an environment survives
// reparenting and `setsid`, where a process group or session does not. A stray
// is a process carrying the chat's id whose parent is gone: its parent is no
// longer one of the chat's own processes AND it was adopted by init (or a
// subreaper), which is what separates it from the agent process itself, whose
// parent is the host or the durable runner.
//
// Reads `/proc`, so Linux only. NO FALLBACK: elsewhere the request fails with
// `unsupported_platform` rather than answering with an empty list, which would
// read as "nothing is running".

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { PatchStrayProcessesRequestEvent, StrayProcessRow, WireEvent } from '@patch/wire';

const CHAT_ENV = 'PATCH_CHAT_ID';
const CLOCK_TICKS_PER_SEC = 100;
/** Parents that adopt orphans. Anything else (host, runner, a shell) is not an adoption. */
const REAPER_COMMS = new Set(['systemd', 'init', 'tini', 'docker-init', 'dumb-init']);
/** Ended strays kept per chat, newest first, so the list cannot grow for ever. */
const MAX_ENDED = 20;
const MAX_COMMAND_CHARS = 500;

export class UnsupportedPlatformError extends Error {
  constructor() {
    super('stray process detection reads /proc and is only available on Linux hosts');
  }
}

export interface StrayDeps {
  procRoot: string;
  now: () => number;
  kill: (pid: number, signal: NodeJS.Signals) => void;
}

export const defaultStrayDeps: StrayDeps = {
  procRoot: '/proc',
  now: () => Date.now(),
  kill: (pid, signal) => process.kill(pid, signal),
};

interface ProcInfo {
  pid: number;
  ppid: number;
  comm: string;
  startTicks: number;
  command: string;
  chatId: string | undefined;
}

function readProc(root: string, pid: number): ProcInfo | null {
  try {
    const stat = readFileSync(join(root, String(pid), 'stat'), 'latin1');
    // `pid (comm) S ppid ...` — comm may hold spaces and parens, so split on the LAST ')'.
    const close = stat.lastIndexOf(')');
    const open = stat.indexOf('(');
    if (close < 0 || open < 0) return null;
    const comm = stat.slice(open + 1, close);
    const rest = stat.slice(close + 2).split(' ');
    const ppid = Number(rest[1]);
    const startTicks = Number(rest[19]);
    if (!Number.isInteger(ppid) || !Number.isFinite(startTicks)) return null;
    let environ = '';
    try {
      environ = readFileSync(join(root, String(pid), 'environ'), 'latin1');
    } catch {
      // not ours to read, or exited
    }
    const prefix = `${CHAT_ENV}=`;
    const chatVar = environ.split('\0').find((e) => e.startsWith(prefix));
    let command = '';
    try {
      command = readFileSync(join(root, String(pid), 'cmdline'), 'utf8')
        .split('\0')
        .join(' ')
        .trim();
    } catch {
      // exited between reads
    }
    return {
      pid,
      ppid,
      comm,
      startTicks,
      command: (command || comm).slice(0, MAX_COMMAND_CHARS),
      chatId: chatVar === undefined ? undefined : chatVar.slice(prefix.length),
    };
  } catch {
    return null;
  }
}

function scanTable(root: string): Map<number, ProcInfo> {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new UnsupportedPlatformError();
    throw e;
  }
  const table = new Map<number, ProcInfo>();
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const info = readProc(root, Number(n));
    if (info) table.set(info.pid, info);
  }
  return table;
}

function bootTimeMs(root: string): number {
  const m = /^btime\s+(\d+)/m.exec(readFileSync(join(root, 'stat'), 'utf8'));
  if (!m) throw new Error(`no btime in ${join(root, 'stat')}`);
  return Number(m[1]) * 1000;
}

/** The chat's strays that are running right now, plus the table they came from. */
function liveStrays(
  chatId: string,
  deps: StrayDeps,
): { strays: ProcInfo[]; table: Map<number, ProcInfo>; boot: number } {
  const table = scanTable(deps.procRoot);
  const boot = bootTimeMs(deps.procRoot);
  const strays: ProcInfo[] = [];
  for (const p of table.values()) {
    if (p.chatId !== chatId || p.pid === process.pid) continue;
    const parent = table.get(p.ppid);
    if (parent?.chatId === chatId) continue; // still inside the chat's own tree
    const adopted = p.ppid === 1 || (parent !== undefined && REAPER_COMMS.has(parent.comm));
    if (adopted) strays.push(p);
  }
  return { strays, table, boot };
}

function descendants(root: number, table: Map<number, ProcInfo>): number[] {
  const out: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const cur = queue.shift() as number;
    for (const p of table.values()) {
      if (p.ppid === cur && !out.includes(p.pid) && p.pid !== root) {
        out.push(p.pid);
        queue.push(p.pid);
      }
    }
  }
  return out;
}

/**
 * What the host has seen of each chat's strays. In memory only, like the
 * background-task count: a stray is a live process, and a record of one that
 * ended is only the host's own observation of it.
 */
export class StrayProcessTracker {
  private readonly seen = new Map<string, Map<string, StrayProcessRow>>();

  constructor(private readonly deps: StrayDeps = defaultStrayDeps) {}

  list(chatId: string): StrayProcessRow[] {
    const { strays, boot } = liveStrays(chatId, this.deps);
    const now = this.deps.now();
    const book = this.seen.get(chatId) ?? new Map<string, StrayProcessRow>();
    this.seen.set(chatId, book);
    const live = new Set<string>();
    for (const p of strays) {
      const key = `${p.pid}:${p.startTicks}`;
      live.add(key);
      book.set(key, {
        pid: p.pid,
        command: p.command,
        startedAt: Math.round(boot + (p.startTicks / CLOCK_TICKS_PER_SEC) * 1000),
        running: true,
      });
    }
    for (const [key, row] of book) {
      if (!live.has(key) && row.running) book.set(key, { ...row, running: false, endedAt: now });
    }
    const ended = [...book.entries()]
      .filter(([, r]) => !r.running)
      .sort((a, b) => (b[1].endedAt ?? 0) - (a[1].endedAt ?? 0));
    for (const [key] of ended.slice(MAX_ENDED)) book.delete(key);
    return [...book.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Stop one running stray and everything it started. False when it is not (or no longer) one. */
  stop(chatId: string, pid: number): boolean {
    const { strays, table } = liveStrays(chatId, this.deps);
    const target = strays.find((p) => p.pid === pid);
    if (!target) return false;
    for (const child of descendants(pid, table).reverse()) this.signal(child);
    this.signal(pid);
    return true;
  }

  private signal(pid: number): void {
    try {
      this.deps.kill(pid, 'SIGTERM');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
    }
  }
}

export function handleStrayProcessesRequest(
  event: PatchStrayProcessesRequestEvent,
  tracker: StrayProcessTracker,
  hasChat: (chatId: string) => boolean,
  sender: (e: WireEvent) => void,
  logger: Logger,
): void {
  const fail = (code: 'chat_not_found' | 'unsupported_platform' | 'internal', message: string) =>
    sender({
      type: 'patch.stray_processes.response',
      requestId: event.requestId,
      ok: false,
      error: { code, message },
    });
  if (!hasChat(event.chatId)) {
    fail('chat_not_found', `chat not found: ${event.chatId}`);
    return;
  }
  try {
    const stopped =
      event.stopPid !== undefined ? tracker.stop(event.chatId, event.stopPid) : undefined;
    const processes = tracker.list(event.chatId);
    sender({
      type: 'patch.stray_processes.response',
      requestId: event.requestId,
      ok: true,
      processes,
      ...(stopped !== undefined ? { stopped } : {}),
    });
  } catch (err) {
    if (err instanceof UnsupportedPlatformError) {
      fail('unsupported_platform', err.message);
      return;
    }
    logger.warn({ err: (err as Error).message, chatId: event.chatId }, 'stray processes failed');
    fail('internal', (err as Error).message);
  }
}
