// Terminal sessions (spec/02-host.md § Terminal sessions, spec/03 § Terminal
// sessions, spec/14 § Terminal).
//
// The host owns the project filesystem, so it owns the shell. A surface opens
// a session against a folder and drives it over the wire — the only route a
// surface has to `git clone` a repo ONTO the host, run an install, or see
// what is actually on disk. Without it a remote host is a closed box: a
// folder that isn't there yet can never be put there.
//
// TWO KINDS OF SESSION. The default is a pipe shell, deliberately: web's
// terminal drawer is a line-at-a-time command box, and pipes cover its use
// case — clone / install / inspect. The cost is that full-screen curses
// programs and TTY-demanding password prompts don't work;
// `GIT_TERMINAL_PROMPT=0` makes the common case of that (git asking for a
// password) fail fast and loudly instead of hanging forever on a prompt nobody
// can answer.
//
// An open that carries `pty` gets a REAL pseudo-terminal instead, for a surface
// drawing with a terminal emulator (the phone). Everything below about the
// completion sentinel applies to pipe sessions only — a terminal's own prompt
// says when a command finished.
//
// EVERY SHELL RUNS UNDER ITS OWN RUNNER (`terminalRunner.ts`), a small detached
// python3 process, never as a child of the host — so a host restart leaves
// every terminal running and the next host reattaches (spec/02 § Host
// restarts). A session in this file is the host's connection to its runner.
//
// NO FALLBACK: a folder that does not exist on the host is a `folder_not_found`
// error frame, never a shell quietly started in `$HOME` or `/` — a shell in the
// wrong place is how you clone a repo into the void.
//
// COMMAND COMPLETION. A pipe shell prints no prompt and echoes nothing, so
// stdout alone can never say that a command finished: `cd /tmp` emits zero
// bytes and looks identical to a session wedged by something reading stdin.
// So each session mints a random marker at spawn, and every input frame that
// ends in a newline is followed by `printf '<marker>:%s\n' "$?"` on the same
// stdin. The shell runs it the moment the command before it returns, which
// makes the marker line mean exactly "that command is done, with this status".
// The marker is stripped out of stdout — it is never surfaced as output — and
// re-emitted as `patch.terminal.command-exit`. The marker is kept beside the
// session on disk, so a host that reattaches still recognises it.
//
// Stripping it means line-buffering stdout, because a marker can straddle a
// chunk boundary. Only the trailing bytes that could still be the start of a
// marker are held back; everything else streams immediately, so `printf` with
// no trailing newline still arrives promptly. stderr is never buffered: the
// sentinel writes to stdout.
//
// KNOWN LIMITATIONS, both accepted rather than worked around:
//   - A multi-line construct typed line by line (a heredoc, an unclosed quote)
//     swallows the injected sentinel into its body, so that command reports no
//     completion until the construct closes.
//   - A command that reads stdin itself (`python3`, `cat`) consumes the
//     sentinel line too and will usually complain about it. That is louder than
//     the alternative — a terminal that silently swallows every later keystroke
//     — and the command stays correctly marked as running until it exits.

import { spawn, execFile } from 'node:child_process';
import {
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { TERMINAL_RUNNER_SOURCE } from './terminalRunner.js';
import { RunnerLink, type RunnerLinkHandlers } from './runnerLink.js';
import type { Logger } from 'pino';
import type { WireEvent } from '@patch/wire';

// NO SESSION CAP. There was a hard limit of 4 concurrent sessions per host.
// It bounded nothing worth bounding: an idle session is one `bash` with three
// pipes (~2MB RSS), while the cost that actually matters is what a session
// RUNS — which a count of shells never constrained. What it did do was reject
// real work, because slots are far easier to hold than to free: one per chat,
// closing the drawer deliberately keeps the shell alive, and a surface that
// reloads strands its old session until the idle timer reaps it. Four reloads
// inside half an hour could exhaust it. Sessions are now bounded by
// IDLE_TIMEOUT_MS alone.

/** A session with no input for this long is ended (spec/02 § Terminal sessions). */
export const IDLE_TIMEOUT_MS = 30 * 60_000;

/** Wait after a Ctrl-C before re-asking the shell for its status. */
export const INTERRUPT_SENTINEL_DELAY_MS = 150;

/** Output rate cap: bytes per session per window before chunks are dropped. */
export const OUTPUT_WINDOW_MS = 1_000;
export const OUTPUT_BYTES_PER_WINDOW = 512 * 1024;

/** Surface→host frames this manager handles. */
type TerminalRequest = Extract<
  WireEvent,
  {
    type:
      | 'patch.terminal.open'
      | 'patch.terminal.input'
      | 'patch.terminal.signal'
      | 'patch.terminal.close'
      | 'patch.terminal.resize';
  }
>;

type EndReason = Extract<WireEvent, { type: 'patch.terminal.exit' }>['reason'];

type SessionKind = 'pty' | 'pipe';

/** What a session keeps on disk, `<runDir>/<random name>/meta.json`. */
interface RunnerMeta {
  sessionId: string;
  forSurfaceId?: string;
  cwd: string;
  /** Output offset the host has handed to the surface. */
  offset: number;
  /** Absent on a record written before pipe sessions had runners: a PTY session. */
  kind?: SessionKind;
  /** A pipe session's completion sentinel. */
  marker?: string;
}

/** The host's side of a session: its runner's directory and connection. */
interface RunnerState {
  dir: string;
  cwd: string;
  link: RunnerLink | null;
  /**
   * Absolute log offset delivered to the surface so far. For a pipe session
   * it only ever lands on a record boundary, because a host that reattaches
   * asks the runner to start from here.
   */
  offset: number;
  /** A pipe session's log bytes past `offset` that do not yet make a whole record. */
  partial: Buffer;
  /** What was asked of the runner before its connection was up, in order. */
  queued: Array<(link: RunnerLink) => void>;
  metaTimer: NodeJS.Timeout | null;
}

interface Session {
  sessionId: string;
  kind: SessionKind;
  /** The surface that opened it — every frame for this session routes there. */
  forSurfaceId?: string;
  /** Set before we kill the shell so the `exit` frame reports WHY it ended. */
  endReason: EndReason | null;
  /** Its `exit` has been reported. A replaced session still reports its own. */
  ended: boolean;
  idleTimer: NodeJS.Timeout;
  /** Rolling output-rate window: start instant + bytes emitted within it. */
  windowStart: number;
  windowBytes: number;
  /** True once this window's truncation notice has been sent (send it once). */
  windowTruncated: boolean;
  /** A pipe session's completion sentinel, `<marker>:<code>` on its own stdout line. */
  marker: string;
  /**
   * Trailing stdout bytes held back because they could still turn out to be
   * the start of the marker. Never more than the marker's own length.
   */
  pendingOut: string;
  /**
   * One UTF-8 decoder per stream. It carries a multi-byte character split
   * across two reads over to the next one, since an emulator draws what it is
   * given and a replacement glyph is a bug.
   */
  decoders: { stdout: StringDecoder; stderr: StringDecoder };
  runner: RunnerState;
}

export interface TerminalSessionsOptions {
  /** Emits a host→surface frame (wired to the server link's sender). */
  emit: (event: WireEvent) => void;
  /**
   * Where a session with NO folder starts. Wired to the host's first
   * published project root, because that is where a clone is going: the
   * host's `$HOME` is `/root` in the container while the project dirs are
   * mounted elsewhere, so homing there would drop the user somewhere they'd
   * only have to `cd` out of. Returning nothing falls through to `$HOME`, and
   * either way `ready.cwd` reports where the shell actually landed.
   */
  defaultCwd?: () => string | undefined;
  /**
   * The interpreter that runs the terminal runner (`terminalRunner.ts`).
   * Injected so a test can name one that does not exist; the host runs
   * `python3` off PATH.
   */
  python?: string;
  /**
   * `<patchHome>/terminals`: one directory per session, holding its runner's
   * socket and output log (spec/02 § Host restarts).
   */
  runDir: string;
  /** Seconds a runner keeps a shell no host is attached to; tests shorten it. */
  orphanSeconds?: number;
  logger?: Logger;
}

/** How long a new runner has to start listening. */
const RUNNER_START_MS = 15_000;
/** Persisting the delivered offset is throttled to this. */
const META_WRITE_MS = 200;
/** A pipe-session log record's header: one stream byte and a 4-byte length. */
const RECORD_HEADER = 5;
const STDERR_TAG = 0x65; // 'e'
/** The longest unix socket path every host OS accepts (macOS: 104 bytes with the terminator). */
const MAX_SOCKET_PATH = 103;

export class TerminalSessions {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly opts: TerminalSessionsOptions) {}

  /** Live session count (tests). */
  count(): number {
    return this.sessions.size;
  }

  /** Route one surface→host terminal frame. */
  handle(event: TerminalRequest): void {
    switch (event.type) {
      case 'patch.terminal.open':
        this.open(event);
        return;
      case 'patch.terminal.input':
        this.input(event);
        return;
      case 'patch.terminal.signal':
        this.interrupt(event);
        return;
      case 'patch.terminal.close':
        this.close(event);
        return;
      case 'patch.terminal.resize':
        this.resize(event);
        return;
    }
  }

  /**
   * The host is going down. Every shell is its runner's, so the host only
   * lets go and the next host reattaches (spec/02 § Host restarts).
   */
  async shutdown(): Promise<void> {
    for (const s of [...this.sessions.values()]) {
      clearTimeout(s.idleTimer);
      this.flushMeta(s);
      s.runner.link?.detach();
      this.sessions.delete(s.sessionId);
    }
  }

  /** End every live session (tests, and anything that means it). */
  async closeAll(): Promise<void> {
    const all = [...this.sessions.values()];
    for (const s of all) this.end(s, 'closed');
    const deadline = Date.now() + 5_000;
    while (all.some((s) => this.sessions.get(s.sessionId) === s) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await this.shutdown();
  }

  // ---- open ----------------------------------------------------------------

  private open(event: Extract<WireEvent, { type: 'patch.terminal.open' }>): void {
    const { sessionId, forSurfaceId } = event;

    // No folder named = "a shell anywhere I can work" (the new-chat case: there
    // is no folder yet, which is the very reason a shell is wanted). Start in
    // the host's home — `ready.cwd` tells the surface exactly where it landed,
    // so this resolves a request, it does not paper over a failure.
    const folder = event.folder ?? this.opts.defaultCwd?.() ?? homedir();

    // A NAMED folder gets the same validation a chat spawn does: missing — or a
    // file — is `folder_not_found`; we never start a shell somewhere else
    // instead. (The home directory is checked too: an unusable HOME is a real
    // host misconfiguration and must be reported, not worked around.)
    let isDir = false;
    try {
      isDir = statSync(folder).isDirectory();
    } catch {
      isDir = false;
    }
    /* v8 ignore next 6 -- the `!isDir` body is covered via a named missing folder; the homedir() side of the same branch would need an unusable HOME on the test host. */
    if (!isDir) {
      this.error(sessionId, 'folder_not_found', `folder does not exist on the host: ${folder}`, {
        forSurfaceId,
      });
      return;
    }

    const existing = this.sessions.get(sessionId);
    // A PTY session that is still running — one the host reattached after a
    // restart, which the surface now asks for again — is taken over, not
    // replaced: its shell, scrollback and running programs stay as they were.
    if (existing?.kind === 'pty' && event.pty !== undefined && existing.runner.link) {
      this.takeOver(existing, forSurfaceId);
      return;
    }
    // Otherwise re-opening a live sessionId replaces its shell (a surface that
    // reconnected and re-opened must not leak the old one).
    if (existing) this.end(existing, 'closed');

    void this.start(sessionId, folder, event.pty, forSurfaceId);
  }

  /**
   * Start a session's runner and connect to it. A pipe session gets three
   * pipes, `TERM=dumb` and the completion sentinel; a PTY session (spec/02 §
   * Terminal sessions — PTY sessions), for a surface that draws with a
   * terminal emulator, gets a real pseudo-terminal: the shell echoes, prints
   * its prompt, completes on Tab and runs full-screen programs, so none of the
   * pipe session's machinery applies — no sentinel (the prompt says a command
   * finished), no stdout/stderr split (a terminal has one output), and Ctrl-C
   * is the ETX byte the line discipline turns into SIGINT for the foreground
   * job, exactly as on a local terminal.
   *
   * NO FALLBACK: if the runner cannot run, the surface gets an error —
   * `pty_unavailable` for a PTY, never a pipe shell drawn into an emulator
   * that expects a terminal.
   */
  private async start(
    sessionId: string,
    folder: string,
    size: { cols: number; rows: number } | undefined,
    forSurfaceId: string | undefined,
  ): Promise<void> {
    const kind: SessionKind = size === undefined ? 'pipe' : 'pty';
    const shell = process.env.SHELL || 'bash';
    const python = this.opts.python ?? 'python3';
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (kind === 'pipe') {
      env.TERM = 'dumb';
      // No TTY means nobody can answer a credential prompt — fail loudly
      // rather than hang the session forever waiting on one.
      env.GIT_TERMINAL_PROMPT = '0';
    } else {
      env.TERM = 'xterm-256color';
      env.COLORTERM = 'truecolor';
      // A pipe session's guard against a credential prompt nobody can answer.
      // A terminal CAN answer one, so it must not inherit the refusal.
      delete env.GIT_TERMINAL_PROMPT;
      // The emulator speaks UTF-8. A host started by systemd often has no
      // locale at all, which leaves the shell in the C locale — readline then
      // draws every non-ASCII keystroke as an octal escape. Only when NOTHING
      // names a character set is one declared; a configured locale is left alone.
      if (!env.LC_ALL && !env.LC_CTYPE && !env.LANG) {
        env.LC_CTYPE = process.platform === 'darwin' ? 'UTF-8' : 'C.UTF-8';
      }
    }
    if (this.opts.orphanSeconds !== undefined) {
      env.PATCH_PTY_ORPHAN_S = String(this.opts.orphanSeconds);
    }

    const dir = this.runnerDir();
    // A socket path past the OS limit can never be connected to; say so now
    // rather than after waiting out the runner's start.
    if (Buffer.byteLength(join(dir, 'sock')) > MAX_SOCKET_PATH) {
      this.error(
        sessionId,
        kind === 'pty' ? 'pty_unavailable' : 'internal',
        `this host cannot open a terminal: its terminals folder ${this.opts.runDir} is too deep for a unix socket path`,
        { forSurfaceId },
      );
      return;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const session = this.newSession(sessionId, kind, forSurfaceId, {
      dir,
      cwd: folder,
      offset: 0,
      // Random per session so a command that happens to print the literal
      // string cannot forge a completion for someone else's shell.
      marker: kind === 'pipe' ? `__patch_exit_${randomBytes(6).toString('hex')}` : '',
    });
    const runner = session.runner;
    this.sessions.set(sessionId, session);
    this.flushMeta(session);

    // The runner's stderr goes to a file: it is the only account of a Python
    // traceback or a failed exec, and the runner outlives this call.
    const errLog = join(dir, 'err.log');
    let failed: string | null = null;
    let spawned: ReturnType<typeof spawn>;
    const cols = size?.cols ?? 0;
    const rows = size?.rows ?? 0;
    try {
      writeFileSync(errLog, '');
      spawned = spawn(
        python,
        ['-c', TERMINAL_RUNNER_SOURCE, dir, String(cols), String(rows), shell, kind],
        { cwd: folder, detached: true, stdio: ['ignore', 'ignore', openAppend(errLog)], env },
      );
    } catch (err) {
      this.failStart(session, (err as Error).message);
      return;
    }
    spawned.unref();
    spawned.on('error', (err: Error) => {
      failed = err.message;
    });
    // Before the runner is attached, its exit is a failure to start (a later
    // one is the shell ending, which the link reports).
    spawned.on('exit', (code) => {
      if (runner.link === null) {
        failed = readFileSafe(errLog).trim() || `exited with status ${code}`;
      }
    });

    const deadline = Date.now() + RUNNER_START_MS;
    let link: RunnerLink | null = null;
    while (link === null) {
      if (failed !== null) {
        this.failStart(session, failed);
        return;
      }
      try {
        link = await RunnerLink.attach(dir, 0, this.linkHandlers(session), 100);
      } catch {
        if (Date.now() > deadline) {
          this.failStart(session, 'the terminal runner never started');
          return;
        }
      }
    }
    // Connected even when it was closed or replaced meanwhile: the kill that
    // asked for is queued, and the shell's end comes back like any other.
    this.connected(session, link);
    if (this.sessions.get(sessionId) !== session) return;
    // Ready only once the runner really is listening, so a missing python3
    // is reported as an error in place of a ready — never after one.
    this.emit(
      {
        type: 'patch.terminal.ready',
        sessionId,
        cwd: folder,
        ...(kind === 'pty' ? { pty: true as const } : {}),
      },
      forSurfaceId,
    );
  }

  private newSession(
    sessionId: string,
    kind: SessionKind,
    forSurfaceId: string | undefined,
    at: { dir: string; cwd: string; offset: number; marker: string },
  ): Session {
    return {
      sessionId,
      kind,
      ...(forSurfaceId !== undefined ? { forSurfaceId } : {}),
      endReason: null,
      ended: false,
      idleTimer: this.armIdleTimer(sessionId),
      windowStart: Date.now(),
      windowBytes: 0,
      windowTruncated: false,
      marker: at.marker,
      pendingOut: '',
      decoders: { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') },
      runner: {
        dir: at.dir,
        cwd: at.cwd,
        link: null,
        offset: at.offset,
        partial: Buffer.alloc(0),
        queued: [],
        metaTimer: null,
      },
    };
  }

  /** The runner is listening: hand it whatever was asked of it meanwhile. */
  private connected(session: Session, link: RunnerLink): void {
    session.runner.link = link;
    for (const op of session.runner.queued.splice(0)) op(link);
  }

  /**
   * Send something to a session's runner, or hold it until the connection is
   * up: a surface may type, or close, before a just-opened shell is listening.
   */
  private toRunner(session: Session, op: (link: RunnerLink) => void): void {
    if (session.runner.link) op(session.runner.link);
    else session.runner.queued.push(op);
  }

  /** The runner never came up: report it and drop everything it left. */
  private failStart(session: Session, why: string): void {
    this.opts.logger?.warn(
      { sessionId: session.sessionId, err: why },
      'terminal runner failed to start',
    );
    clearTimeout(session.idleTimer);
    if (this.sessions.get(session.sessionId) === session) this.sessions.delete(session.sessionId);
    if (session.runner.metaTimer) clearTimeout(session.runner.metaTimer);
    rmSync(session.runner.dir, { recursive: true, force: true });
    this.error(
      session.sessionId,
      session.kind === 'pty' ? 'pty_unavailable' : 'internal',
      `this host cannot open a terminal: ${this.opts.python ?? 'python3'} failed to start (${why})`,
      { forSurfaceId: session.forSurfaceId },
    );
  }

  /** What the runner's connection reports, applied to `session`. */
  private linkHandlers(session: Session): RunnerLinkHandlers {
    return {
      onData: (start, data, replay) => this.runnerData(session, start, data, replay),
      onExit: (code) => this.runnerEnded(session, code),
      onClose: () => {
        // The connection dropped without the shell reporting an end: the runner
        // was killed. Whatever it wrote before dying is in the log; nothing
        // else will come.
        this.runnerEnded(session, null);
      },
    };
  }

  /**
   * Log bytes from the runner, skipping what the surface already has. A PTY
   * session's log is its terminal output; a pipe session's is a run of
   * records (`terminalRunner.ts`), each one stream's chunk, decoded here.
   */
  private runnerData(session: Session, start: number, data: Buffer, replay: boolean): void {
    const runner = session.runner;
    const have = runner.offset + runner.partial.length;
    let chunk = data;
    if (start < have) {
      const seen = have - start;
      if (seen >= chunk.length) return;
      chunk = chunk.subarray(seen);
    } else if (start > have) {
      // The runner trimmed its log past what we had: the gap is gone.
      runner.offset = start;
      runner.partial = Buffer.alloc(0);
    }
    if (session.kind === 'pty') {
      runner.offset += chunk.length;
      this.output(session, 'stdout', chunk, replay);
    } else {
      let buf = runner.partial.length > 0 ? Buffer.concat([runner.partial, chunk]) : chunk;
      while (buf.length >= RECORD_HEADER) {
        const length = buf.readUInt32BE(1);
        if (buf.length < RECORD_HEADER + length) break;
        const stream = buf[0] === STDERR_TAG ? 'stderr' : 'stdout';
        const body = buf.subarray(RECORD_HEADER, RECORD_HEADER + length);
        buf = buf.subarray(RECORD_HEADER + length);
        runner.offset += RECORD_HEADER + length;
        this.output(session, stream, body, replay);
      }
      runner.partial = Buffer.from(buf);
    }
    this.scheduleMeta(session);
  }

  /** The shell ended (or its runner vanished): tell the surface and clean up. */
  private runnerEnded(session: Session, code: number | null): void {
    if (session.ended) return;
    session.ended = true;
    const runner = session.runner;
    // Only drop the map entry if it is still OURS: a re-open of the same
    // sessionId replaces the entry, and the old shell's end lands afterwards.
    if (this.sessions.get(session.sessionId) === session) this.sessions.delete(session.sessionId);
    clearTimeout(session.idleTimer);
    if (runner.metaTimer) clearTimeout(runner.metaTimer);
    runner.link?.detach();
    rmSync(runner.dir, { recursive: true, force: true });
    this.emit(
      {
        type: 'patch.terminal.exit',
        sessionId: session.sessionId,
        code: session.endReason === null ? code : null,
        // A runner that died with no word from its shell was killed with the
        // machine; the surface treats it like a host that went away.
        reason: session.endReason ?? (code === null ? 'daemon_shutdown' : 'shell_exit'),
      },
      session.forSurfaceId,
    );
  }

  /**
   * A surface asks for a PTY session the host already has running — reattached
   * after a restart. It gets the same shell, drawn again from the start of its
   * scrollback.
   */
  private takeOver(session: Session, forSurfaceId: string | undefined): void {
    const runner = session.runner;
    if (forSurfaceId === undefined) delete session.forSurfaceId;
    else session.forSurfaceId = forSurfaceId;
    clearTimeout(session.idleTimer);
    session.idleTimer = this.armIdleTimer(session.sessionId);
    this.emit(
      { type: 'patch.terminal.ready', sessionId: session.sessionId, cwd: runner.cwd, pty: true },
      forSurfaceId,
    );
    // Re-attach from the beginning: the runner replays its whole log and the
    // offset bookkeeping starts over so none of it is skipped as "seen".
    runner.link?.detach();
    runner.link = null;
    runner.offset = 0;
    runner.partial = Buffer.alloc(0);
    session.decoders.stdout = new StringDecoder('utf8');
    RunnerLink.attach(runner.dir, 0, this.linkHandlers(session), 0).then(
      (link) => {
        this.connected(session, link);
        this.flushMeta(session);
      },
      (err: Error) => {
        this.opts.logger?.warn({ err: err.message }, 'terminal reattach failed');
        this.runnerEnded(session, null);
      },
    );
  }

  // ---- reattach after a host restart (spec/02 § Host restarts) ---------------

  /**
   * Adopt the sessions a previous host left running. Called once at start. A
   * runner still up is reattached and everything it printed since the last
   * offset the previous host delivered goes to the surface; one whose shell
   * ended meanwhile hands over its last output and the exit; one that is gone
   * (a machine restart) is reported ended.
   */
  async adopt(): Promise<number> {
    let names: string[];
    try {
      names = readdirSync(this.opts.runDir);
    } catch {
      return 0;
    }
    let adopted = 0;
    for (const name of names) {
      const dir = join(this.opts.runDir, name);
      let meta: RunnerMeta;
      try {
        meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as RunnerMeta;
      } catch {
        // No readable record: nothing can be told to anyone. Leave a clean slate.
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (this.sessions.has(meta.sessionId)) continue;
      const session = this.newSession(meta.sessionId, meta.kind ?? 'pty', meta.forSurfaceId, {
        dir,
        cwd: meta.cwd,
        offset: meta.offset,
        marker: meta.marker ?? '',
      });
      this.sessions.set(meta.sessionId, session);
      try {
        const link = await RunnerLink.attach(dir, meta.offset, this.linkHandlers(session), 0);
        this.connected(session, link);
        adopted++;
      } catch {
        // Runner not listening: either its shell ended while no host was
        // attached (exit.json), or it was killed. Either way the log has the rest.
        this.replayFromDisk(session);
      }
    }
    return adopted;
  }

  /** A runner that is gone: deliver what its log still holds, then its end. */
  private replayFromDisk(session: Session): void {
    const runner = session.runner;
    let code: number | null = null;
    try {
      code = (JSON.parse(readFileSync(join(runner.dir, 'exit.json'), 'utf8')) as { code: number })
        .code;
    } catch {
      code = null;
    }
    try {
      const base = Number(readFileSync(join(runner.dir, 'out.base'), 'utf8'));
      const log = readFileSync(join(runner.dir, 'out.log'));
      const from = Math.max(runner.offset, base);
      const rest = log.subarray(from - base);
      if (rest.length > 0) this.runnerData(session, from, rest, true);
    } catch {
      // No log: nothing was ever printed.
    }
    this.runnerEnded(session, code);
  }

  /**
   * A new directory per runner, even for a re-opened sessionId: the shell it
   * replaces is still ending in its own. The name is short because the
   * runner's socket lives inside it and a unix socket path is limited to
   * ~104 bytes; the sessionId is in `meta.json`.
   */
  private runnerDir(): string {
    return join(this.opts.runDir, randomBytes(5).toString('hex'));
  }

  private scheduleMeta(session: Session): void {
    const runner = session.runner;
    if (runner.metaTimer) return;
    runner.metaTimer = setTimeout(() => {
      runner.metaTimer = null;
      this.flushMeta(session);
    }, META_WRITE_MS);
    runner.metaTimer.unref?.();
  }

  /** Write the record a restarted host reads (atomic: temp file and rename). */
  private flushMeta(session: Session): void {
    const runner = session.runner;
    if (runner.metaTimer) {
      clearTimeout(runner.metaTimer);
      runner.metaTimer = null;
    }
    const meta: RunnerMeta = {
      sessionId: session.sessionId,
      ...(session.forSurfaceId !== undefined ? { forSurfaceId: session.forSurfaceId } : {}),
      cwd: runner.cwd,
      offset: runner.offset,
      kind: session.kind,
      ...(session.kind === 'pipe' ? { marker: session.marker } : {}),
    };
    try {
      const tmp = join(runner.dir, 'meta.json.tmp');
      writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 });
      renameSync(tmp, join(runner.dir, 'meta.json'));
    } catch (err) {
      // The directory is gone (the session ended): nothing to record.
      this.opts.logger?.debug({ err: (err as Error).message }, 'terminal meta write skipped');
    }
  }

  private resize(event: Extract<WireEvent, { type: 'patch.terminal.resize' }>): void {
    const session = this.require(event.sessionId, event.forSurfaceId);
    if (!session) return;
    if (session.kind === 'pipe') {
      this.error(session.sessionId, 'not_a_pty', 'a pipe session has no window to resize', {
        forSurfaceId: event.forSurfaceId,
      });
      return;
    }
    this.toRunner(session, (link) => link.resize(event.cols, event.rows));
  }

  // ---- input / signal / close ---------------------------------------------

  private input(event: Extract<WireEvent, { type: 'patch.terminal.input' }>): void {
    const session = this.require(event.sessionId, event.forSurfaceId);
    if (!session) return;
    clearTimeout(session.idleTimer);
    session.idleTimer = this.armIdleTimer(session.sessionId);
    this.toRunner(session, (link) => link.input(event.data));
    // A terminal needs no sentinel — its prompt says when a command is done.
    if (session.kind === 'pty') return;
    // A complete line is a command the shell will run, so ask it to report the
    // status the moment it returns. Input that does NOT end in a newline is a
    // partial line — half a command, or bytes being fed to something's stdin —
    // and a sentinel there would be spliced into the middle of it.
    if (!event.data.endsWith('\n')) return;
    this.toRunner(session, (link) => link.input(this.sentinel(session)));
  }

  private sentinel(session: Session): string {
    return `printf '${session.marker}:%s\\n' "$?"\n`;
  }

  /**
   * Ctrl-C. A pipe shell and its children share one process group, so a
   * group-wide SIGINT would take the session down with the command. Instead we
   * signal the shell's DESCENDANTS only — the foreground command and anything
   * it spawned — leaving the shell itself alive to take the next command. The
   * runner records the shell's pid for this.
   */
  private interrupt(event: Extract<WireEvent, { type: 'patch.terminal.signal' }>): void {
    const session = this.require(event.sessionId, event.forSurfaceId);
    if (!session) return;
    // A terminal interrupts the way a keyboard does: ETX to the line
    // discipline, which signals whatever job is in the foreground — and only
    // that job, which the descendant walk below cannot know.
    if (session.kind === 'pty') {
      this.toRunner(session, (link) => link.input('\x03'));
      return;
    }
    const shellPid = Number(readFileSafe(join(session.runner.dir, 'shell.pid')));
    if (!Number.isInteger(shellPid) || shellPid <= 0) {
      this.opts.logger?.warn({ sessionId: session.sessionId }, 'terminal interrupt: no shell pid');
      return;
    }
    execFile('ps', ['-A', '-o', 'pid=,ppid='], (err, stdout) => {
      /* v8 ignore next 4 -- `ps` is present on every host the host runs on (Linux container + macOS dev); its failure path can't be exercised without removing it. */
      if (err) {
        this.opts.logger?.warn({ err: err.message }, 'terminal interrupt: ps failed');
        return;
      }
      for (const pid of descendantsOf(stdout, shellPid)) {
        /* v8 ignore next 5 -- the pid vanishing between the `ps` listing and the signal is a real race, but not one a test can schedule. */
        try {
          process.kill(pid, 'SIGINT');
        } catch {
          // Already gone — nothing to interrupt.
        }
      }
      // A command that reads stdin (`cat`, `python3`, `ssh`) swallowed the
      // sentinel queued behind it, so once the interrupt kills it nothing
      // would ever report it finished and the prompt would claim it was still
      // running forever. A fresh sentinel, sent once the signal has landed,
      // is read by the shell itself. For a command that did NOT eat its
      // sentinel this is a second, harmless `command-exit`.
      setTimeout(() => {
        if (this.sessions.get(session.sessionId) !== session) return;
        this.toRunner(session, (link) => link.input(this.sentinel(session)));
      }, INTERRUPT_SENTINEL_DELAY_MS);
    });
  }

  private close(event: Extract<WireEvent, { type: 'patch.terminal.close' }>): void {
    const session = this.require(event.sessionId, event.forSurfaceId);
    if (!session) return;
    this.end(session, 'closed');
  }

  // ---- internals -----------------------------------------------------------

  /** Look a session up, reporting `unknown_session` when it isn't there. */
  private require(sessionId: string, forSurfaceId?: string): Session | null {
    const session = this.sessions.get(sessionId);
    if (session) return session;
    this.error(sessionId, 'unknown_session', `no terminal session ${sessionId}`, { forSurfaceId });
    return null;
  }

  /**
   * End a session's shell and its whole process group, attributing the reason
   * to its exit frame. The runner does the killing, and the end comes back over
   * its connection like any other.
   */
  private end(session: Session, reason: EndReason): void {
    session.endReason = reason;
    clearTimeout(session.idleTimer);
    this.toRunner(session, (link) => link.kill());
  }

  private armIdleTimer(sessionId: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const session = this.sessions.get(sessionId);
      // The timer is cleared on exit/close, so it can only fire while the
      // session is live.
      /* v8 ignore next 2 */
      if (!session) return;
      this.opts.logger?.info({ sessionId }, 'terminal session idle-timed out');
      this.end(session, 'idle_timeout');
    }, IDLE_TIMEOUT_MS);
    // A pending idle timer must not hold the process open.
    timer.unref?.();
    return timer;
  }

  /**
   * Stream one chunk back, subject to the per-session rate cap. A runaway
   * command (`yes`, a build with a firehose of logs) must not be able to flood
   * the link; over the cap we drop chunks for the rest of the window and say so
   * once, so the user knows output is missing rather than silently losing it.
   *
   * stdout additionally passes the completion-sentinel filter. Markers are
   * pulled out even while the window is dropping output: the frame is a handful
   * of bytes, and losing it would leave the surface showing a command as
   * running forever because too much scrolled past.
   */
  private output(session: Session, stream: 'stdout' | 'stderr', buf: Buffer, replay = false): void {
    const now = Date.now();
    if (now - session.windowStart >= OUTPUT_WINDOW_MS) {
      session.windowStart = now;
      session.windowBytes = 0;
      session.windowTruncated = false;
    }
    session.windowBytes += buf.length;
    // Scrollback handed back after a reattach is history, not a firehose.
    const dropping = !replay && session.windowBytes > OUTPUT_BYTES_PER_WINDOW;
    if (dropping && !session.windowTruncated) {
      session.windowTruncated = true;
      this.emit(
        {
          type: 'patch.terminal.output',
          sessionId: session.sessionId,
          stream: 'stderr',
          data: '\n[patch] output truncated — too much output too fast\n',
        },
        session.forSurfaceId,
      );
    }
    const text = session.decoders[stream].write(buf);
    if (session.kind === 'pty') {
      if (!dropping && text !== '') this.emitOutput(session, stream, text);
      return;
    }
    // The sentinel is written to stdout, so stderr needs no line buffering and
    // streams byte-for-byte exactly as it arrives.
    if (stream === 'stderr') {
      if (!dropping && text !== '') this.emitOutput(session, 'stderr', text);
      return;
    }
    this.takeMarkers(session, text, dropping);
  }

  /**
   * Run one stdout chunk through the sentinel filter, emitting the bytes the
   * surface should see and a `command-exit` for every completion it carries,
   * interleaved in the order the shell actually produced them.
   */
  private takeMarkers(session: Session, text: string, dropping: boolean): void {
    const read = readMarkers(`${session.marker}:`, session.pendingOut, text);
    session.pendingOut = read.pending;
    // IN ORDER. A chunk can carry output, a completion, and the next command's
    // output all at once, and emitting every exit frame first would file the
    // `exit 2` line above the error that earned it — or, when a chunk lands
    // mid-message, between the two halves of one line.
    for (const segment of read.segments) {
      if (segment.kind === 'exit') {
        this.emit(
          { type: 'patch.terminal.command-exit', sessionId: session.sessionId, code: segment.code },
          session.forSurfaceId,
        );
        continue;
      }
      if (!dropping && segment.data !== '') this.emitOutput(session, 'stdout', segment.data);
    }
  }

  /** Emit one output chunk for a session, routed to its owning surface. */
  private emitOutput(session: Session, stream: 'stdout' | 'stderr', data: string): void {
    this.emit(
      { type: 'patch.terminal.output', sessionId: session.sessionId, stream, data },
      session.forSurfaceId,
    );
  }

  private error(
    sessionId: string,
    code: Extract<WireEvent, { type: 'patch.terminal.error' }>['code'],
    message: string,
    opts: { forSurfaceId?: string },
  ): void {
    this.emit({ type: 'patch.terminal.error', sessionId, code, message }, opts.forSurfaceId);
  }

  /** Stamp the owning surface so the hub routes the frame to it alone. */
  private emit(event: WireEvent, forSurfaceId?: string): void {
    this.opts.emit(forSurfaceId === undefined ? event : ({ ...event, forSurfaceId } as WireEvent));
  }
}

/**
 * One piece of a stdout chunk, in the order the shell produced it: bytes for
 * the surface, or a command that finished with a status.
 */
export type MarkerSegment = { kind: 'out'; data: string } | { kind: 'exit'; code: number };

/**
 * Split a stdout chunk into ordered segments, pulling out every completion
 * sentinel.
 *
 * `pending` is whatever the previous chunk held back, since the pipe decides
 * where chunks break and a marker can straddle one. Returns the segments in
 * order and the tail to hold for next time.
 *
 * ORDER IS THE POINT. One chunk routinely carries the tail of a command's
 * output, that command's sentinel, and the start of the next one. Reporting
 * the completions separately from the bytes would put `exit 2` above the error
 * that produced it, or — when the chunk lands mid-line — between the halves of
 * a single message.
 *
 * A marker is matched anywhere on a line, not just at its start: a command
 * whose last line has no newline (`printf 'Password: '`) leaves the sentinel
 * appended to it, and those bytes still have to reach the surface without a
 * line break being invented for them.
 */
export function readMarkers(
  prefix: string,
  pending: string,
  text: string,
): { segments: MarkerSegment[]; pending: string } {
  const joined = pending + text;
  const cut = joined.lastIndexOf('\n');
  const complete = cut === -1 ? '' : joined.slice(0, cut + 1);
  const partial = cut === -1 ? joined : joined.slice(cut + 1);

  const segments: MarkerSegment[] = [];
  /** Append output, coalescing with the run of bytes already being built. */
  const pushOut = (data: string): void => {
    if (data === '') return;
    const last = segments[segments.length - 1];
    if (last?.kind === 'out') last.data += data;
    else segments.push({ kind: 'out', data });
  };

  if (complete.includes(prefix)) {
    for (const line of complete.slice(0, -1).split('\n')) {
      const hit = splitMarker(prefix, line);
      if (hit === null) {
        pushOut(`${line}\n`);
        continue;
      }
      // The newline belonged to the sentinel's own `printf`, so it goes with
      // it — keeping it would invent a break the command never printed.
      pushOut(hit.text);
      segments.push({ kind: 'exit', code: hit.code });
    }
  } else {
    pushOut(complete);
  }

  // Hold back ONLY the tail that could still grow into a marker. Holding the
  // whole unterminated line instead would stall every prompt written without a
  // trailing newline until the next chunk happened to arrive.
  const held = markerTail(prefix, partial);
  pushOut(held === 0 ? partial : partial.slice(0, partial.length - held));
  return { segments, pending: held === 0 ? '' : partial.slice(-held) };
}

/**
 * A completion sentinel on one stdout line: the bytes before it (the command's
 * own unterminated output, usually nothing) and the exit code it carries.
 * `null` when this line is not a sentinel.
 */
export function splitMarker(prefix: string, line: string): { text: string; code: number } | null {
  const at = line.indexOf(prefix);
  if (at === -1) return null;
  const rest = line.slice(at + prefix.length);
  // `$?` is always a non-negative integer, so anything else on the line means
  // the marker was printed by the command rather than by our own `printf`.
  if (!/^\d+$/.test(rest)) return null;
  return { text: line.slice(0, at), code: Number(rest) };
}

/**
 * How many trailing characters of an unterminated stdout line have to be held
 * back because they could still turn into a completion sentinel — the sentinel
 * already in full but waiting on its digits, or any suffix that is the
 * beginning of one. Zero means the whole line can stream now.
 */
export function markerTail(prefix: string, partial: string): number {
  const at = partial.indexOf(prefix);
  if (at !== -1) return partial.length - at;
  const from = Math.min(partial.length, prefix.length - 1);
  for (let k = from; k > 0; k--) {
    if (prefix.startsWith(partial.slice(-k))) return k;
  }
  return 0;
}

/**
 * Every descendant pid of `rootPid`, from `ps -A -o pid=,ppid=` output. Used by
 * the interrupt path: the foreground command plus anything it spawned, without
 * the shell itself.
 */
export function descendantsOf(psOutput: string, rootPid: number): number[] {
  const children = new Map<number, number[]>();
  for (const line of psOutput.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  const out: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const next = queue.shift() as number;
    for (const child of children.get(next) ?? []) {
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/** Open `path` for appending and return the descriptor (a runner's stderr). */
function openAppend(path: string): number {
  return openSync(path, 'a');
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
