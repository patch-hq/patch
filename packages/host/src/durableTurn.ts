// Turns that outlive the host (spec/02 § Turns outlive the host).
//
// Every Claude turn runs under its own detached runner (`turnRunner.ts`) rather
// than as a child of the host. This module is the host's half: it starts the
// runner, and hands the Agent SDK a `SpawnedProcess` that talks to it over the
// runner's socket instead of over pipes the host owns. To the SDK nothing has
// changed — it writes stream-json to stdin and reads it from stdout.
//
// When the host restarts mid-turn, the next host builds the SAME `query()` for
// the chat (same options, same callbacks) and this module REATTACHES it to the
// runner instead of spawning a new claude:
//
//   - the SDK's `initialize` request is not forwarded (claude was initialised
//     by the first host and would refuse a second); the original answer, kept
//     in `out.jsonl`, is handed back under the new request id;
//   - the prompt the SDK writes is dropped — claude already has it;
//   - everything claude has said is replayed from the start, so the SDK and
//     `oneShotRun` rebuild their per-turn state (tool names, limit events),
//     and `oneShotRun` skips the envelopes the previous host had already
//     handled (`consumed.json`, written as each one is handled);
//   - a control request claude made that the previous host never answered —
//     a permission prompt, a hook — is delivered again, so the new host asks
//     it again; one it did answer (`in.jsonl` holds the answer) is not.
//
// Nothing here waits for an idle machine: the point is that a restart can
// happen at any moment.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect, type Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { linkUserConfigIntoResumeDir } from './claudeSpawn.js';
import {
  RUNNER_EXIT,
  RUNNER_IN,
  RUNNER_INFO,
  RUNNER_OUT,
  RUNNER_SOCKET,
  type RunnerExit,
} from './turnRunner.js';

export interface DurableTurnConfig {
  /** `<patchHome>/turns` — one directory per chat with a turn in flight. */
  turnsDir: string;
  /** How to start `bin/turn-runner`; the turn directory is appended. */
  runner: { command: string; args: string[] };
}

/**
 * How far the host got through a turn's output: every envelope of every
 * message whose line ends before `offset`, and the first `envelopes` of the
 * one ending AT `offset` (-1 = all of them).
 */
export interface Consumed {
  offset: number;
  envelopes: number;
}

export interface DurableTurnLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface DurableTurnRequest {
  config: DurableTurnConfig;
  chatId: string;
  /** The turn's surface id, so a restart can match the turn to its runner. */
  localId?: string | undefined;
  /** The account the turn runs on, kept so a reattaching host blames the right one. */
  accountId?: string | undefined;
  /** Set when this run carries on a turn a previous host started. */
  attach?: { consumed: Consumed | null } | undefined;
  log: DurableTurnLog;
}

const TURN_META = 'turn.json';
const CONSUMED = 'consumed.json';
const RUNNER_LOG = 'runner.log';
/** The field each replayed/live line carries to `oneShotRun`, then loses. */
export const OFFSET_FIELD = '__patchOffset';

export function turnDirFor(config: DurableTurnConfig, chatId: string): string {
  return join(config.turnsDir, chatId);
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface TurnOnDisk {
  dir: string;
  chatId: string;
  localId?: string;
  accountId?: string;
  /**
   * `live`: the runner is up (claude may or may not still be running);
   * `exited`: claude finished while no host was attached and everything it
   * said is on disk; `lost`: neither — the runner was killed (a reboot), so
   * the turn really was cut off.
   */
  state: 'live' | 'exited' | 'lost';
  consumed: Consumed | null;
}

/** What is on disk for `chatId`'s turn, or undefined when it has none. */
export function inspectTurn(config: DurableTurnConfig, chatId: string): TurnOnDisk | undefined {
  return inspectTurnDir(turnDirFor(config, chatId));
}

export function inspectTurnDir(dir: string): TurnOnDisk | undefined {
  const meta = readJson<{ chatId: string; localId?: string; accountId?: string }>(
    join(dir, TURN_META),
  );
  if (!meta) return undefined;
  const info = readJson<{ pid: number }>(join(dir, RUNNER_INFO));
  const exited = existsSync(join(dir, RUNNER_EXIT));
  const live =
    !exited && info !== undefined && isAlive(info.pid) && existsSync(join(dir, RUNNER_SOCKET));
  return {
    dir,
    chatId: meta.chatId,
    ...(meta.localId !== undefined ? { localId: meta.localId } : {}),
    ...(meta.accountId !== undefined ? { accountId: meta.accountId } : {}),
    state: exited ? 'exited' : live ? 'live' : 'lost',
    consumed: readJson<Consumed>(join(dir, CONSUMED)) ?? null,
  };
}

/** Every chat that has a turn directory. */
export function listTurnDirs(config: DurableTurnConfig): string[] {
  if (!existsSync(config.turnsDir)) return [];
  return readdirSync(config.turnsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/**
 * End a turn nobody is going to carry on — its chat was deleted, or a new turn
 * is about to take its place — and remove its directory. Kills claude's whole
 * process group and the runner.
 */
export function retireTurn(dir: string): void {
  const info = readJson<{ pid?: number; claudePid?: number | null }>(join(dir, RUNNER_INFO));
  const kill = (target: number, signal: NodeJS.Signals): void => {
    try {
      process.kill(target, signal);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
    }
  };
  if (info?.claudePid) kill(-info.claudePid, 'SIGKILL');
  if (info?.pid && isAlive(info.pid)) kill(info.pid, 'SIGTERM');
  rmSync(dir, { recursive: true, force: true });
}

/**
 * The install folders live runners were started from. An install prunes old
 * version folders; a runner — and the patch tools server its claude may
 * restart — must keep the folder it came from (installer/main.ts).
 */
export function versionDirsInUse(turnsDir: string, versionsDir: string): Set<string> {
  const used = new Set<string>();
  if (!existsSync(turnsDir)) return used;
  const root = resolve(versionsDir);
  for (const name of readdirSync(turnsDir)) {
    let info: { pid?: number; script?: string | null } | undefined;
    try {
      info = readJson(join(turnsDir, name, RUNNER_INFO));
    } catch {
      continue;
    }
    if (!info?.pid || !info.script || !isAlive(info.pid)) continue;
    let dir = resolve(info.script);
    while (dirname(dir) !== dir && dirname(dir) !== root) dir = dirname(dir);
    if (dirname(dir) === root) used.add(dir);
  }
  return used;
}

// ---- Live turns in this process ---------------------------------------------

const liveTurns = new Set<DurableTurn>();
/**
 * Set as this process goes (graceful shutdown, a crash, an install's
 * restart). From then on nothing may kill a runner: the SDK's own exit hook
 * SIGTERMs every process it spawned, and here that would be the very turn
 * that is meant to carry on.
 */
let detaching = false;

// Registered when this module loads — before the SDK, which registers its own
// exit hook on its first spawn — so `detaching` is already set when the SDK's
// hook calls `kill` on each of our processes.
process.on('exit', () => {
  detaching = true;
  for (const t of liveTurns) t.persistConsumed();
});

/**
 * Let go of every turn without ending it, ahead of this process exiting. Each
 * runner keeps its claude going and the next host reattaches. After this the
 * SDK receives nothing more, so the turns stop being handled here at a point
 * `consumed.json` records exactly.
 */
export function detachDurableTurns(): number {
  detaching = true;
  for (const t of liveTurns) t.detach();
  return liveTurns.size;
}

/** Whether `chatId` has a turn running under a runner right now. */
export function hasDurableTurn(chatId: string): boolean {
  for (const t of liveTurns) if (t.chatId === chatId && t.runnerUp) return true;
  return false;
}

/** Test hook: forget a previous detach, as a fresh process would. */
export function resetDurableTurnsForTest(): void {
  detaching = false;
  liveTurns.clear();
}

// ---- One turn ----------------------------------------------------------------

/** What `oneShotRun` should do with a message from the stream. */
export interface MessagePlan {
  /** The line's end offset, or undefined for a message that carried none. */
  offset: number | undefined;
  /** Envelopes to skip because the previous host handled them; -1 = all. */
  skip: number;
}

export class DurableTurn {
  readonly chatId: string;
  readonly dir: string;
  private proc: RunnerProcess | undefined;
  private consumed: Consumed | null;
  private consumedDirty = false;
  private readonly skipUntil: Consumed | null;

  constructor(private readonly req: DurableTurnRequest) {
    this.chatId = req.chatId;
    this.dir = turnDirFor(req.config, req.chatId);
    this.consumed = req.attach?.consumed ?? null;
    this.skipUntil = req.attach ? (req.attach.consumed ?? null) : null;
  }

  /** claude's pid, once the runner has started it. */
  claudePid(): number | undefined {
    return (
      readJson<{ claudePid?: number | null }>(join(this.dir, RUNNER_INFO))?.claudePid ?? undefined
    );
  }

  get runnerUp(): boolean {
    return this.proc !== undefined && !this.proc.finished;
  }

  /** The SDK's `spawnClaudeCodeProcess`. */
  spawn = (opts: SpawnOptions): SpawnedProcess => {
    linkUserConfigIntoResumeDir(opts.env);
    liveTurns.add(this);
    const proc = this.req.attach ? this.reattach() : this.start(opts);
    this.proc = proc;
    const onAbort = (): void => {
      proc.kill('SIGTERM');
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
    proc.once('exit', () => opts.signal.removeEventListener('abort', onAbort));
    return proc;
  };

  private start(opts: SpawnOptions): RunnerProcess {
    if (existsSync(this.dir)) {
      // Restart recovery either carries on a chat's turn or retires it, so a
      // directory still here is a turn nobody will carry on. Say so: its
      // claude may have been doing work this turn now replaces.
      this.req.log.error(
        { chatId: this.chatId, dir: this.dir },
        'durable turn: a previous turn of this chat was still on disk; ending it',
      );
      retireTurn(this.dir);
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeJsonAtomic(join(this.dir, TURN_META), {
      chatId: this.chatId,
      ...(this.req.localId !== undefined ? { localId: this.req.localId } : {}),
      ...(this.req.accountId !== undefined ? { accountId: this.req.accountId } : {}),
      startedAt: Date.now(),
    });
    const logFd = openSync(join(this.dir, RUNNER_LOG), 'a');
    const child = spawn(
      this.req.config.runner.command,
      [...this.req.config.runner.args, this.dir],
      {
        cwd: this.dir,
        // Its own session: launchd/systemd stopping the host, or the host's
        // own process group going, must not reach it.
        detached: true,
        stdio: ['pipe', 'ignore', logFd],
        windowsHide: true,
      },
    );
    closeSync(logFd);
    const proc = new RunnerProcess(this, 'fresh');
    // The spawn spec — credentials included — travels over the pipe, never
    // through a file.
    const stdin = child.stdin as Writable;
    stdin.on('error', (err) => proc.fail(new Error(`turn runner stdin: ${err.message}`)));
    stdin.end(
      JSON.stringify({ command: opts.command, args: opts.args, cwd: opts.cwd, env: opts.env }),
    );
    child.on('error', (err) =>
      proc.fail(new Error(`could not start the turn runner: ${err.message}`)),
    );
    child.on('exit', (code, signal) => {
      // Once connected, the socket closing is what reports a runner that went.
      if (!proc.finished && !proc.connected && !detaching) {
        proc.fail(
          new Error(
            `the turn runner exited (${code ?? signal}) without reporting claude's exit; see ${join(this.dir, RUNNER_LOG)}`,
          ),
        );
      }
    });
    child.unref();
    proc.connect();
    return proc;
  }

  private reattach(): RunnerProcess {
    const disk = inspectTurnDir(this.dir);
    if (!disk || disk.state === 'lost') {
      throw new Error(`durable turn: nothing to reattach to for chat ${this.chatId}`);
    }
    const proc = new RunnerProcess(this, 'attach', readAttachState(this.dir));
    this.req.log.info(
      { chatId: this.chatId, state: disk.state, consumed: this.consumed },
      'durable turn: reattaching to a turn the previous host started',
    );
    return proc;
  }

  /** Read and strip a message's offset, and say how much of it to skip. */
  plan(msg: unknown): MessagePlan {
    if (typeof msg !== 'object' || msg === null) return { offset: undefined, skip: 0 };
    const m = msg as Record<string, unknown>;
    const offset = typeof m[OFFSET_FIELD] === 'number' ? (m[OFFSET_FIELD] as number) : undefined;
    delete m[OFFSET_FIELD];
    const until = this.skipUntil;
    if (offset === undefined || until === null) return { offset, skip: 0 };
    if (offset < until.offset) return { offset, skip: -1 };
    if (offset === until.offset) return { offset, skip: until.envelopes };
    return { offset, skip: 0 };
  }

  /** Record that `envelopes` of the message ending at `offset` were handled (-1 = all). */
  noteConsumed(offset: number, envelopes: number, persist: boolean): void {
    this.consumed = { offset, envelopes };
    this.consumedDirty = true;
    if (persist) this.persistConsumed();
  }

  persistConsumed(): void {
    if (!this.consumedDirty || this.consumed === null || !existsSync(this.dir)) return;
    writeJsonAtomic(join(this.dir, CONSUMED), this.consumed);
    this.consumedDirty = false;
  }

  detach(): void {
    this.persistConsumed();
    this.proc?.detach();
  }

  /**
   * The run is over. A finished turn's directory goes; one this process is
   * letting go of stays for the next host. A run that ended with claude still
   * going (the SDK gave up on it) ends claude too, so nothing is left behind.
   */
  release(): void {
    if (detaching) return;
    liveTurns.delete(this);
    const proc = this.proc;
    if (!proc || proc.exited) {
      rmSync(this.dir, { recursive: true, force: true });
      return;
    }
    proc.kill('SIGKILL');
    const timer = setTimeout(() => {
      this.req.log.warn({ chatId: this.chatId }, 'durable turn: runner did not exit; retiring it');
      retireTurn(this.dir);
    }, 5000);
    timer.unref();
    proc.once('exit', () => {
      clearTimeout(timer);
      rmSync(this.dir, { recursive: true, force: true });
    });
  }

  get isDetaching(): boolean {
    return detaching;
  }

  get logger(): DurableTurnLog {
    return this.req.log;
  }
}

// ---- Reattach bookkeeping ------------------------------------------------------

interface ControlRequestLine {
  type: 'control_request';
  request_id: string;
  request: { subtype: string; callback_id?: string; hooks?: HookConfig };
}
interface ControlResponseLine {
  type: 'control_response';
  response: { request_id: string; [k: string]: unknown };
}
type HookConfig = Record<string, Array<{ matcher?: unknown; hookCallbackIds: string[] }>> | null;

export interface AttachState {
  /** The first host's `initialize` request id, and the hooks it registered. */
  initRequestId: string | undefined;
  initHooks: HookConfig;
  /** Control requests from claude that a host has already answered. */
  answered: Set<string>;
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(line) as unknown;
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Read what was said TO claude: its initialisation, and every answer it was given. */
export function readAttachState(dir: string): AttachState {
  const path = join(dir, RUNNER_IN);
  const state: AttachState = { initRequestId: undefined, initHooks: null, answered: new Set() };
  if (!existsSync(path)) return state;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.length === 0) continue;
    const m = parseLine(line);
    if (!m) continue;
    if (m['type'] === 'control_request') {
      const r = m as unknown as ControlRequestLine;
      if (r.request?.subtype === 'initialize' && state.initRequestId === undefined) {
        state.initRequestId = r.request_id;
        state.initHooks = r.request.hooks ?? null;
      }
    } else if (m['type'] === 'control_response') {
      const id = (m as unknown as ControlResponseLine).response?.request_id;
      if (typeof id === 'string') state.answered.add(id);
    }
  }
  return state;
}

/**
 * Map the first host's hook callback ids onto the new host's, position by
 * position within each event. The SDK numbers them `hook_0`, `hook_1`, … in
 * registration order, so for an unchanged configuration this is the identity;
 * after an update that changed the hooks, a callback with no counterpart maps
 * to nothing and is answered as a no-op (see RunnerProcess).
 */
export function mapHookIds(oldHooks: HookConfig, newHooks: HookConfig): Map<string, string> {
  const map = new Map<string, string>();
  for (const [event, oldMatchers] of Object.entries(oldHooks ?? {})) {
    const newMatchers = newHooks?.[event] ?? [];
    oldMatchers.forEach((m, i) => {
      m.hookCallbackIds.forEach((id, j) => {
        const to = newMatchers[i]?.hookCallbackIds[j];
        if (to !== undefined) map.set(id, to);
      });
    });
  }
  return map;
}

/** Tag a stream-json line with its end offset, for `DurableTurn.plan`. */
export function tagLine(line: string, end: number): string {
  if (!line.startsWith('{') || /^\{\s*\}$/.test(line)) return line;
  return `{"${OFFSET_FIELD}":${end},${line.slice(1)}`;
}

// ---- The SDK-facing process --------------------------------------------------

class RunnerProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  killed = false;
  exitCode: number | null = null;
  finished = false;
  exited = false;
  private sock: Socket | undefined;
  get connected(): boolean {
    return this.sock !== undefined;
  }
  private queue: string[] = [];
  private inBuf = '';
  private outBuf = '';
  private detached = false;
  // Reattach only.
  private newInitRequestId: string | undefined;
  private promptDropped = false;
  private hookMap = new Map<string, string>();
  private readonly issued = new Set<string>();

  constructor(
    private readonly turn: DurableTurn,
    private readonly mode: 'fresh' | 'attach',
    private readonly attach?: AttachState,
  ) {
    super();
    this.stdout = new Readable({ read() {} });
    this.stdin = new Writable({
      write: (chunk: Buffer | string, _enc, cb) => {
        this.inBuf += chunk.toString();
        let nl = this.inBuf.indexOf('\n');
        while (nl !== -1) {
          const line = this.inBuf.slice(0, nl);
          this.inBuf = this.inBuf.slice(nl + 1);
          nl = this.inBuf.indexOf('\n');
          if (line.length > 0) this.onInput(line);
        }
        cb();
      },
      final: (cb) => {
        this.frame({ t: 'end' });
        cb();
      },
    });
  }

  connect(attempt = 0): void {
    const sock = connect(join(this.turn.dir, RUNNER_SOCKET));
    sock.once('connect', () => {
      this.sock = sock;
      sock.setEncoding('utf8');
      sock.on('data', (chunk: string) => this.onSocketData(chunk));
      sock.on('close', () => {
        if (this.finished || this.detached || this.turn.isDetaching) return;
        // Every frame the runner sent arrives before `close`, so an exit it
        // recorded but whose frame never came is still read from disk.
        const exit = readJson<RunnerExit>(join(this.turn.dir, RUNNER_EXIT));
        if (exit) this.finish(exit.code, exit.signal);
        else this.fail(new Error('lost the connection to the turn runner before claude exited'));
      });
      sock.on('error', () => undefined);
      sock.write(`${JSON.stringify({ t: 'attach', from: 0 })}\n`);
      for (const f of this.queue) sock.write(f);
      this.queue = [];
    });
    sock.once('error', (err: NodeJS.ErrnoException) => {
      if (this.sock === sock) return;
      // The runner creates its socket a moment after it starts.
      if (
        (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') &&
        attempt < 400 &&
        !this.finished
      ) {
        setTimeout(() => this.connect(attempt + 1), 25);
        return;
      }
      this.fail(new Error(`could not reach the turn runner: ${err.message}`));
    });
  }

  private frame(f: unknown): void {
    if (this.finished || this.detached) return;
    const text = `${JSON.stringify(f)}\n`;
    if (this.sock) this.sock.write(text);
    else this.queue.push(text);
  }

  private onSocketData(chunk: string): void {
    this.outBuf += chunk;
    let nl = this.outBuf.indexOf('\n');
    while (nl !== -1) {
      const raw = this.outBuf.slice(0, nl);
      this.outBuf = this.outBuf.slice(nl + 1);
      nl = this.outBuf.indexOf('\n');
      if (this.detached) return;
      const f = parseLine(raw) as { t?: string; line?: string; end?: number } & Partial<RunnerExit>;
      if (!f) continue;
      if (f.t === 'out' && typeof f.line === 'string' && typeof f.end === 'number') {
        this.onOutput(f.line, f.end);
      } else if (f.t === 'exit') {
        this.finish(f.code ?? null, f.signal ?? null);
      }
    }
  }

  // ---- stdin: what the SDK says to claude ----

  private onInput(line: string): void {
    if (this.mode === 'fresh') {
      this.frame({ t: 'in', line });
      return;
    }
    const m = parseLine(line);
    if (m?.['type'] === 'control_request') {
      const r = m as unknown as ControlRequestLine;
      if (r.request?.subtype === 'initialize' && this.newInitRequestId === undefined) {
        // claude is already initialised; its first answer is replayed instead.
        this.newInitRequestId = r.request_id;
        this.hookMap = mapHookIds(this.attach?.initHooks ?? null, r.request.hooks ?? null);
        this.beginReplay();
        return;
      }
      this.issued.add(r.request_id);
    } else if (m?.['type'] === 'user' && !this.promptDropped) {
      // claude has had this prompt since the first host sent it.
      this.promptDropped = true;
      return;
    } else if (m?.['type'] === 'control_response') {
      const id = (m as unknown as ControlResponseLine).response?.request_id;
      if (typeof id === 'string') this.attach?.answered.add(id);
    }
    this.frame({ t: 'in', line });
  }

  private beginReplay(): void {
    if (inspectTurnDir(this.turn.dir)?.state === 'live') {
      this.connect();
      return;
    }
    // claude finished while no host was attached: everything is on disk.
    const outPath = join(this.turn.dir, RUNNER_OUT);
    const text = existsSync(outPath) ? readFileSync(outPath) : Buffer.alloc(0);
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] !== 0x0a) continue;
      this.onOutput(text.subarray(start, i).toString('utf8'), i + 1);
      start = i + 1;
    }
    const exit = readJson<RunnerExit>(join(this.turn.dir, RUNNER_EXIT));
    this.finish(exit?.code ?? null, exit?.signal ?? null);
  }

  // ---- stdout: what claude says ----

  private onOutput(line: string, end: number): void {
    if (this.mode === 'attach') {
      const m = parseLine(line);
      if (m?.['type'] === 'control_response') {
        const resp = (m as unknown as ControlResponseLine).response;
        if (resp?.request_id === this.attach?.initRequestId && this.newInitRequestId) {
          this.push(
            JSON.stringify({ ...m, response: { ...resp, request_id: this.newInitRequestId } }),
            end,
          );
        } else if (resp && this.issued.has(resp.request_id)) {
          this.push(line, end);
        }
        // Any other answer was to a request the previous host made; nothing
        // here is waiting for it.
        return;
      }
      if (m?.['type'] === 'control_request') {
        const r = m as unknown as ControlRequestLine;
        if (this.attach?.answered.has(r.request_id)) return;
        if (r.request?.subtype === 'hook_callback' && r.request.callback_id !== undefined) {
          const to = this.hookMap.get(r.request.callback_id);
          if (to === undefined) {
            this.turn.logger.warn(
              { chatId: this.turn.chatId, callbackId: r.request.callback_id },
              'durable turn: a hook the previous host registered has no counterpart here; answering it as a no-op',
            );
            this.frame({
              t: 'in',
              line: JSON.stringify({
                type: 'control_response',
                response: { subtype: 'success', request_id: r.request_id, response: {} },
              }),
            });
            this.attach?.answered.add(r.request_id);
            return;
          }
          this.push(JSON.stringify({ ...r, request: { ...r.request, callback_id: to } }), end);
          return;
        }
      }
    }
    this.push(line, end);
  }

  private push(line: string, end: number): void {
    this.stdout.push(`${tagLine(line, end)}\n`);
  }

  // ---- lifecycle ----

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    // Going down with the host is exactly what a runner exists not to do.
    if (this.turn.isDetaching || this.detached || this.finished) return false;
    this.killed = true;
    this.frame({ t: 'kill', signal });
    return true;
  }

  detach(): void {
    this.detached = true;
    this.sock?.destroy();
  }

  finish(code: number | null, signal: string | null): void {
    if (this.finished) return;
    this.finished = true;
    this.exited = true;
    this.exitCode = code;
    this.stdout.push(null);
    setImmediate(() => this.emit('exit', code, signal));
  }

  fail(err: Error): void {
    if (this.finished) return;
    this.finished = true;
    this.turn.logger.error({ chatId: this.turn.chatId, err: err.message }, 'durable turn failed');
    // The SDK listens for this from the moment it spawns; after it has let go
    // there is no one to tell but the log.
    if (this.listenerCount('error') > 0) this.emit('error', err);
    this.stdout.push(null);
  }
}
