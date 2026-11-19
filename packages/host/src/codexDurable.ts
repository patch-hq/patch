// Codex turns that outlive the host (spec/02 § Host restarts).
//
// A Codex turn runs on its own `codex app-server` process, one per turn
// (`CodexAccounts.turnClient`). That process used to be a child of the host,
// talking over pipes the host held, so a host restart ended the turn. This
// module gives it the same detached runner a Claude turn has (`turnRunner.ts`):
// the runner owns app-server's stdio and keeps everything said to and by it on
// disk, under `<patchHome>/turns/<chatId>/`, and the host talks to the runner
// over its socket.
//
// The wire is JSON-RPC lines both ways, which the runner already carries as
// opaque lines. After a restart the next host reattaches (`attach`), and is
// handed back:
//
//   - every message app-server sent after the point the previous host had
//     handled (`consumed.json`), so nothing is shown twice;
//   - every request app-server made of the host (an approval, a question) that
//     the previous host had not yet answered, so the user is asked again.
//
// Responses to the previous host's own requests are never replayed: nothing
// here is waiting for them, and their ids could collide with new ones. The new
// host's request ids start past the highest the previous one used.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import {
  CONSUMED,
  RUNNER_LOG,
  TURN_META,
  inspectTurnDir,
  isAlive,
  isDetachingDurableTurns,
  runnerLogTail,
  keepRunnerLog,
  readJson,
  registerLiveTurn,
  retireTurn,
  SUPPORTED_RUNNER_PROTOCOLS,
  turnDirFor,
  unregisterLiveTurn,
  writeJsonAtomic,
  type Consumed,
  type DurableTurnRequest,
  type LiveTurn,
} from './durableTurn.js';
import { inWorkSlice } from './workSlice.js';
import {
  CLAUDE_STDERR,
  RUNNER_EXIT,
  RUNNER_IN,
  RUNNER_INFO,
  RUNNER_OUT,
  RUNNER_SOCKET,
  type RunnerExit,
} from './turnRunner.js';

type Rpc = Record<string, any>;

function parseObject(line: string): Rpc | undefined {
  try {
    const v = JSON.parse(line) as unknown;
    return typeof v === 'object' && v !== null ? (v as Rpc) : undefined;
  } catch {
    return undefined;
  }
}

function linesOf(path: string): string[] {
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
    : [];
}

/** What a turn directory says about the Codex turn it holds. */
export interface RecoveredCodexTurn {
  threadId?: string;
  threadPath?: string;
  turnId?: string;
  /** The highest request id the previous host used, so new ones start past it. */
  maxRequestId: number;
  /** Ids of app-server's own requests that a host has already answered. */
  answered: Set<number | string>;
}

/**
 * Read what the turn's host said to app-server (`in.jsonl`) and what it
 * answered (`out.jsonl`), to find the thread and turn the turn was running.
 */
export function recoverCodexTurn(dir: string): RecoveredCodexTurn {
  const methodById = new Map<number | string, string>();
  const answered = new Set<number | string>();
  let maxRequestId = 0;
  for (const line of linesOf(join(dir, RUNNER_IN))) {
    const m = parseObject(line);
    if (!m || m['id'] === undefined) continue;
    if (typeof m['method'] === 'string') {
      methodById.set(m['id'], m['method']);
      if (typeof m['id'] === 'number') maxRequestId = Math.max(maxRequestId, m['id']);
    } else answered.add(m['id']);
  }
  const out: RecoveredCodexTurn = { maxRequestId, answered };
  for (const line of linesOf(join(dir, RUNNER_OUT))) {
    const m = parseObject(line);
    if (!m) continue;
    if (typeof m['method'] === 'string') {
      const turn = m['params']?.turn;
      if (m['method'] === 'turn/started' && typeof turn?.id === 'string' && !out.turnId)
        out.turnId = turn.id;
      continue;
    }
    const method = methodById.get(m['id']);
    const result = m['result'] as Rpc | undefined;
    if (
      (method === 'thread/start' || method === 'thread/resume' || method === 'thread/fork') &&
      typeof result?.thread?.id === 'string'
    ) {
      out.threadId = result.thread.id;
      if (typeof result.thread.path === 'string') out.threadPath = result.thread.path;
    } else if (method === 'turn/start' && typeof result?.turn?.id === 'string') {
      out.turnId = result.turn.id;
    }
  }
  return out;
}

/**
 * Which lines of a turn's output a reattaching host is handed: those after the
 * point the previous host had handled, plus each request of app-server's it
 * had not answered. Responses are never replayed.
 */
export function shouldReplay(
  line: string,
  end: number,
  consumed: Consumed | null,
  answered: Set<number | string>,
): boolean {
  const m = parseObject(line);
  if (!m || typeof m['method'] !== 'string') return false;
  if (consumed === null || end > consumed.offset) return true;
  return m['id'] !== undefined && !answered.has(m['id']);
}

export interface DurableCodexSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}

export interface DurableCodexHandlers {
  /** One line app-server wrote, with the offset just past it in `out.jsonl`. */
  onLine(line: string, end: number): void;
  /** app-server is gone, or the runner is. */
  onExit(reason: string): void;
}

/** Which process a runner holds: `codex app-server`. */
interface DurableProcessKind {
  /** Shown in errors: "Codex process exited". */
  name: string;
  /** Written to `turn.json` and used in log lines. */
  harness: string;
}
const CODEX_KIND: DurableProcessKind = { name: 'Codex', harness: 'codex' };

/** The host's end of one Codex turn's runner. */
export class DurableCodexProcess implements LiveTurn {
  readonly chatId: string;
  readonly dir: string;
  private sock: Socket | undefined;
  private queue: string[] = [];
  private buf = '';
  private detached = false;
  private finished = false;
  private consumed: Consumed | null;
  private consumedDirty = false;
  private readonly ownerId: string | undefined;
  private replayUntil = 0;
  private handlers: DurableCodexHandlers | undefined;
  private answered: Set<number | string>;
  /** Recovered state, set when this process carries on a previous host's turn. */
  readonly recovered: RecoveredCodexTurn | undefined;

  private readonly kind: DurableProcessKind = CODEX_KIND;
  constructor(private readonly req: DurableTurnRequest) {
    this.chatId = req.chatId;
    this.dir = turnDirFor(req.config, req.chatId);
    this.consumed = req.attach?.consumed ?? null;
    this.recovered = req.attach ? recoverCodexTurn(this.dir) : undefined;
    this.answered = this.recovered?.answered ?? new Set();
    this.ownerId = req.attach
      ? readJson<{ ownerId?: string }>(join(this.dir, TURN_META))?.ownerId
      : randomUUID();
  }

  get attaching(): boolean {
    return this.req.attach !== undefined;
  }
  get runnerUp(): boolean {
    return !this.finished && (this.sock !== undefined || !this.detached);
  }
  get exited(): boolean {
    return this.finished;
  }
  /** app-server's pid, once the runner has started it. */
  codexPid(): number | undefined {
    return (
      readJson<{ claudePid?: number | null }>(join(this.dir, RUNNER_INFO))?.claudePid ?? undefined
    );
  }

  /** Whether the previous host's runner can be carried on at all. */
  static attachable(req: DurableTurnRequest): boolean {
    const disk = inspectTurnDir(turnDirFor(req.config, req.chatId));
    return (
      disk !== undefined &&
      disk.state !== 'lost' &&
      SUPPORTED_RUNNER_PROTOCOLS.includes(disk.protocol)
    );
  }

  /** Start a runner for a new turn and connect to it. */
  start(spec: DurableCodexSpec, handlers: DurableCodexHandlers): void {
    this.handlers = handlers;
    registerLiveTurn(this);
    if (existsSync(this.dir)) {
      this.req.log.error(
        { chatId: this.chatId, dir: this.dir },
        `durable ${this.kind.harness} turn: a previous turn of this chat was still on disk; ending it`,
      );
      keepRunnerLog(this.dir, 'leftover');
      retireTurn(this.dir);
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(join(this.dir, TURN_META), {
      chatId: this.chatId,
      ownerId: this.ownerId,
      harness: this.kind.harness,
      ...(this.req.localId !== undefined ? { localId: this.req.localId } : {}),
      ...(this.req.accountId !== undefined ? { accountId: this.req.accountId } : {}),
      startedAt: Date.now(),
    });
    const logFd = openSync(join(this.dir, RUNNER_LOG), 'a');
    const launch = inWorkSlice(this.req.config.runner.command, [
      ...this.req.config.runner.args,
      this.dir,
    ]);
    const child = spawn(launch.command, launch.args, {
      cwd: this.dir,
      detached: true,
      stdio: ['pipe', 'ignore', logFd],
      windowsHide: true,
    });
    closeSync(logFd);
    const stdin = child.stdin as Writable;
    stdin.on('error', (err) => this.fail(`turn runner stdin: ${err.message}`));
    // Credentials travel over the pipe, never through a file.
    stdin.end(JSON.stringify(spec));
    child.on('error', (err) => this.fail(`could not start the turn runner: ${err.message}`));
    child.on('exit', (code, signal) => {
      if (!this.finished && this.sock === undefined && !this.detached && !isDetachingDurableTurns())
        this.fail(
          `the turn runner exited (${code ?? signal}) without reporting ${this.kind.harness}'s exit${runnerLogTail(join(this.dir, RUNNER_LOG))}`,
        );
    });
    child.unref();
    this.connect();
  }

  /** Carry on a turn the previous host left running. */
  attach(handlers: DurableCodexHandlers): void {
    const disk = inspectTurnDir(this.dir);
    if (!disk || disk.state === 'lost')
      throw new Error(
        `durable ${this.kind.harness} turn: nothing to reattach to for chat ${this.chatId}`,
      );
    if (!SUPPORTED_RUNNER_PROTOCOLS.includes(disk.protocol))
      throw new Error(
        `durable ${this.kind.harness} turn: chat ${this.chatId}'s runner speaks protocol ${disk.protocol}; this host speaks ${SUPPORTED_RUNNER_PROTOCOLS.join(', ')}`,
      );
    this.handlers = handlers;
    registerLiveTurn(this);
    this.req.log.info(
      { chatId: this.chatId, state: disk.state, consumed: this.consumed },
      `durable ${this.kind.harness} turn: reattaching to a turn the previous host started`,
    );
    const outPath = join(this.dir, RUNNER_OUT);
    this.replayUntil = existsSync(outPath) ? statSync(outPath).size : 0;
    if (disk.state === 'live') {
      this.connect();
      return;
    }
    // app-server finished while no host was attached: everything is on disk.
    const text = existsSync(outPath) ? readFileSync(outPath) : Buffer.alloc(0);
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] !== 0x0a) continue;
      this.onOut(text.subarray(start, i).toString('utf8'), i + 1);
      start = i + 1;
    }
    const exit = readJson<RunnerExit>(join(this.dir, RUNNER_EXIT));
    this.exit(`${this.kind.name} process exited (${exit?.signal ?? exit?.code ?? 'unknown'})`);
  }

  private connect(attempt = 0): void {
    const sock = connect(join(this.dir, RUNNER_SOCKET));
    sock.once('connect', () => {
      this.sock = sock;
      sock.setEncoding('utf8');
      sock.on('data', (chunk: string) => this.onData(chunk));
      sock.on('close', () => {
        if (this.finished || this.detached || isDetachingDurableTurns()) return;
        const exit = readJson<RunnerExit>(join(this.dir, RUNNER_EXIT));
        if (exit) this.exit(`${this.kind.name} process exited (${exit.signal ?? exit.code})`);
        else this.fail(`lost the connection to the turn runner before ${this.kind.name} exited`);
      });
      sock.on('error', () => undefined);
      sock.write(`${JSON.stringify({ t: 'attach', from: 0 })}\n`);
      for (const f of this.queue) sock.write(f);
      this.queue = [];
    });
    sock.once('error', (err: NodeJS.ErrnoException) => {
      if (this.sock === sock) return;
      if (
        (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') &&
        attempt < 400 &&
        !this.finished
      ) {
        setTimeout(() => this.connect(attempt + 1), 25);
        return;
      }
      this.fail(`could not reach the turn runner: ${err.message}`);
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl = this.buf.indexOf('\n');
    while (nl !== -1) {
      const raw = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      nl = this.buf.indexOf('\n');
      if (this.detached) return;
      const f = parseObject(raw);
      if (!f) continue;
      if (f['t'] === 'out' && typeof f['line'] === 'string' && typeof f['end'] === 'number')
        this.onOut(f['line'], f['end']);
      else if (f['t'] === 'exit')
        this.exit(`${this.kind.name} process exited (${f['signal'] ?? f['code'] ?? 'unknown'})`);
    }
  }

  private onOut(line: string, end: number): void {
    if (
      this.attaching &&
      end <= this.replayUntil &&
      !shouldReplay(line, end, this.consumed, this.answered)
    )
      return;
    this.handlers?.onLine(line, end);
  }

  /** Say something to app-server. */
  write(line: string): void {
    if (this.finished || this.detached) throw new Error(`${this.kind.name} is not running`);
    const text = `${JSON.stringify({ t: 'in', line })}\n`;
    if (this.sock) this.sock.write(text);
    else this.queue.push(text);
  }

  /** Signal app-server's whole process group, via its runner. */
  kill(signal: NodeJS.Signals): void {
    if (this.finished || this.detached || isDetachingDurableTurns()) return;
    const text = `${JSON.stringify({ t: 'kill', signal })}\n`;
    if (this.sock) this.sock.write(text);
    else this.queue.push(text);
  }

  /** The host has handled everything app-server said up to `offset`. */
  noteConsumed(offset: number): void {
    this.consumed = { offset, envelopes: -1 };
    this.consumedDirty = true;
    this.persistConsumed();
  }

  persistConsumed(): void {
    if (!this.consumedDirty || this.consumed === null || !existsSync(this.dir)) return;
    writeJsonAtomic(join(this.dir, CONSUMED), this.consumed);
    this.consumedDirty = false;
  }

  /** Let go without ending anything: the next host reattaches. */
  detach(): void {
    this.persistConsumed();
    this.detached = true;
    this.sock?.destroy();
  }

  /** Whether this process is letting go of the turn rather than ending it. */
  get letGo(): boolean {
    return this.detached || isDetachingDurableTurns();
  }

  /** app-server's own stderr tail, for the host log. */
  stderrTail(bytes = 8192): string[] {
    const path = join(this.dir, CLAUDE_STDERR);
    if (!existsSync(path)) return [];
    const text = readFileSync(path);
    return text
      .subarray(Math.max(0, text.length - bytes))
      .toString('utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
  }

  /**
   * The turn is over, or is being abandoned: end app-server and the runner and
   * remove the directory (unless a newer turn of the chat has taken it over).
   */
  release(): void {
    unregisterLiveTurn(this);
    if (this.letGo) return;
    this.finished = true;
    const owns = (): boolean => {
      const meta = readJson<{ ownerId?: string }>(join(this.dir, TURN_META));
      return meta === undefined || meta.ownerId === this.ownerId;
    };
    if (!owns()) return;
    const info = readJson<{ pid?: number }>(join(this.dir, RUNNER_INFO));
    this.kill = () => undefined;
    if (this.sock && !this.sock.destroyed) {
      this.sock.write(`${JSON.stringify({ t: 'kill', signal: 'SIGKILL' })}\n`);
    }
    // The runner kills app-server's group on `kill`, then exits when it is
    // gone. Retire it outright if it does not.
    const timer = setTimeout(() => {
      if (owns()) {
        keepRunnerLog(this.dir, 'unresponsive');
        retireTurn(this.dir);
      }
    }, 5000);
    timer.unref();
    const done = (): void => {
      clearTimeout(timer);
      if (owns()) rmSync(this.dir, { recursive: true, force: true });
    };
    const poll = setInterval(() => {
      if (!info?.pid || !isAlive(info.pid) || existsSync(join(this.dir, RUNNER_EXIT))) {
        clearInterval(poll);
        done();
      }
    }, 50);
    poll.unref();
    this.sock?.end();
  }

  private exit(reason: string): void {
    if (this.finished) return;
    this.finished = true;
    this.handlers?.onExit(reason);
  }

  private fail(reason: string): void {
    if (this.finished) return;
    this.req.log.error(
      { chatId: this.chatId, err: reason },
      `durable ${this.kind.harness} turn failed`,
    );
    this.finished = true;
    this.handlers?.onExit(reason);
  }
}
