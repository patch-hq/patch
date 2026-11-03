// The per-turn runner (spec/02 § Turns outlive the host).
//
// A turn's `claude` process used to be a child of the host, talking over pipes
// the host held. When the host went — a self-update, `launchctl kickstart`, a
// systemd restart — those pipes closed and the turn died with it, which is why
// an update had to wait for a moment when nothing on the machine was mid-turn.
//
// This process sits between the two. The host starts it detached (its own
// session, so neither launchd's process-group kill nor the host's own exit
// reaches it), hands it the spawn spec on stdin, and from then on talks to it
// over a unix socket in the turn's directory. It owns claude's stdio, so
// claude keeps running whether or not a host is connected, and it writes
// everything claude says to `out.jsonl` and everything said to claude to
// `in.jsonl`. A host that restarts reattaches, reads both, and carries on from
// where the last one stopped (`durableTurn.ts`).
//
// It is deliberately small and imports nothing from the host: it is started
// once per turn and lives as long as the turn does.
//
// Files in the turn directory:
//   runner.json   { pid, claudePid, script }    written once claude is spawned
//   out.jsonl     claude's stdout, one JSON line per record, append-only
//   in.jsonl      every line written to claude's stdin, append-only
//   exit.json     { code, signal }               written when claude has exited
//   s             the unix socket
//
// Socket frames are JSON lines. From the host: `attach {from}`, `in {line}`,
// `end`, `kill {signal}`. To the host: `out {line, end}` (end = byte offset in
// out.jsonl just past this line) and `exit {code, signal}`.

import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { killTagged, newTurnTag, TURN_TAG_ENV } from './turnTag.js';

export interface RunnerSpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}

export const RUNNER_SOCKET = 's';
export const RUNNER_OUT = 'out.jsonl';
export const RUNNER_IN = 'in.jsonl';
export const RUNNER_EXIT = 'exit.json';
export const RUNNER_INFO = 'runner.json';

/**
 * How long a runner waits with no host attached and claude silent before it
 * ends claude itself. A claude that is waiting on something only a host can
 * answer (a permission prompt) would otherwise hold the runner, and the chat's
 * "running" state, for ever once the host that owned the turn is not coming back.
 */
export const ORPHAN_IDLE_ENV = 'PATCH_TURN_ORPHAN_IDLE_MS';
export const DEFAULT_ORPHAN_IDLE_MS = 30 * 60 * 1000;

export interface RunnerExit {
  code: number | null;
  signal: string | null;
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`);
  renameSync(tmp, path);
}

/** Split a byte range of `out.jsonl` into lines, each with the offset just past it. */
export function readOutLines(
  fd: number,
  from: number,
  to: number,
): Array<{ line: string; end: number }> {
  if (to <= from) return [];
  const buf = Buffer.alloc(to - from);
  let read = 0;
  while (read < buf.length) {
    const n = readSync(fd, buf, read, buf.length - read, from + read);
    if (n === 0) break;
    read += n;
  }
  const out: Array<{ line: string; end: number }> = [];
  let start = 0;
  for (let i = 0; i < read; i += 1) {
    if (buf[i] !== 0x0a) continue;
    out.push({ line: buf.subarray(start, i).toString('utf8'), end: from + i + 1 });
    start = i + 1;
  }
  return out;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function runTurnRunner(dir: string): Promise<void> {
  const spec = JSON.parse(await readStdin()) as RunnerSpawnSpec;
  const log = (msg: string): void => {
    process.stderr.write(`${new Date().toISOString()} turn-runner ${process.pid}: ${msg}\n`);
  };

  const outFd = openSync(join(dir, RUNNER_OUT), 'a+');
  const inFd = openSync(join(dir, RUNNER_IN), 'a');
  let offset = fstatSync(outFd).size;

  const clients = new Set<Socket>();
  const live = new Set<Socket>();
  let exited: RunnerExit | null = null;
  let stdinEnded = false;
  // The last time a host was attached or claude said anything. A runner nobody
  // is attached to and claude is not talking on is an orphan once this is old.
  let lastActivity = Date.now();
  const orphanIdleMs = Number(process.env[ORPHAN_IDLE_ENV] ?? DEFAULT_ORPHAN_IDLE_MS);

  const send = (sock: Socket, frame: unknown): void => {
    if (!sock.destroyed) sock.write(`${JSON.stringify(frame)}\n`);
  };

  const turnTag = newTurnTag();
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...spec.env, [TURN_TAG_ENV]: turnTag },
    stdio: ['pipe', 'pipe', 'ignore'],
    // claude leads its own process group, as it did as the host's child
    // (claudeSpawn.ts): one kill(-pgid) takes everything it started.
    detached: true,
    windowsHide: true,
  });
  const pgid = child.pid;
  // `script` names the install this runner came from, so an install that
  // prunes old version folders leaves alone one a live turn still uses
  // (installer/main.ts `pruneOldVersions`).
  writeJsonAtomic(join(dir, RUNNER_INFO), {
    pid: process.pid,
    claudePid: pgid ?? null,
    script: process.argv[1] ?? null,
  });
  log(`spawned claude pid ${pgid ?? '?'}`);

  const killGroup = (signal: NodeJS.Signals): void => {
    if (pgid === undefined) return;
    try {
      process.kill(-pgid, signal);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH')
        log(`kill ${signal}: ${(e as Error).message}`);
    }
  };

  const endStdin = (): void => {
    if (stdinEnded) return;
    stdinEnded = true;
    child.stdin.end();
  };
  // A broken pipe means claude has gone; its exit is reported on its own.
  child.stdin.on('error', (err) => log(`claude stdin: ${err.message}`));

  const writeIn = (line: string): void => {
    writeSync(inFd, `${line}\n`);
    if (!stdinEnded) child.stdin.write(`${line}\n`);
  };

  let partial = '';
  const emitLine = (line: string): void => {
    const bytes = `${line}\n`;
    writeSync(outFd, bytes);
    lastActivity = Date.now();
    offset += Buffer.byteLength(bytes);
    for (const c of live) send(c, { t: 'out', line, end: offset });
    // A one-shot turn's input ends with its result: the SDK closes claude's
    // stdin the moment the result arrives. Doing it here too means a turn
    // that finishes while no host is attached still exits, instead of
    // waiting forever on a stdin nobody will close.
    if (line.includes('"result"')) {
      try {
        if ((JSON.parse(line) as { type?: unknown }).type === 'result') endStdin();
      } catch {
        // Not JSON: the SDK skips such lines too.
      }
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    partial += chunk;
    let nl = partial.indexOf('\n');
    while (nl !== -1) {
      emitLine(partial.slice(0, nl));
      partial = partial.slice(nl + 1);
      nl = partial.indexOf('\n');
    }
  });

  const server = createServer((sock) => {
    clients.add(sock);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const raw = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        let frame: { t?: string; from?: number; line?: string; signal?: NodeJS.Signals };
        try {
          frame = JSON.parse(raw) as typeof frame;
        } catch {
          log(`dropping unreadable frame from host: ${raw.slice(0, 200)}`);
          continue;
        }
        if (frame.t === 'attach') {
          // Synchronous read then subscribe: no line can be written between
          // the two, so the host sees every line exactly once.
          for (const l of readOutLines(outFd, frame.from ?? 0, offset))
            send(sock, { t: 'out', ...l });
          live.add(sock);
          if (exited) send(sock, { t: 'exit', ...exited });
        } else if (frame.t === 'in' && typeof frame.line === 'string') {
          writeIn(frame.line);
        } else if (frame.t === 'end') {
          endStdin();
        } else if (frame.t === 'kill') {
          killGroup(frame.signal ?? 'SIGTERM');
          if (frame.signal === 'SIGKILL') killTagged(turnTag);
        }
      }
    });
    const drop = (): void => {
      clients.delete(sock);
      live.delete(sock);
      lastActivity = Date.now();
    };
    sock.on('close', drop);
    sock.on('error', drop);
  });
  const sockPath = join(dir, RUNNER_SOCKET);
  if (existsSync(sockPath)) unlinkSync(sockPath);
  server.listen(sockPath);

  const orphanWatch = setInterval(
    () => {
      if (live.size > 0 || Date.now() - lastActivity < orphanIdleMs) return;
      log(`no host attached and claude silent for ${orphanIdleMs}ms; ending the orphaned turn`);
      clearInterval(orphanWatch);
      killGroup('SIGKILL');
    },
    Math.max(50, Math.min(60_000, orphanIdleMs / 4)),
  );

  child.on('error', (err) => log(`claude spawn error: ${err.message}`));
  // `close` follows both the exit and the end of claude's stdout, so every
  // line it wrote is in out.jsonl before exit.json says it is finished.
  child.on('close', (code, signal) => {
    if (partial.length > 0) emitLine(partial);
    partial = '';
    clearInterval(orphanWatch);
    exited = { code, signal };
    writeJsonAtomic(join(dir, RUNNER_EXIT), exited);
    log(`claude exited code=${code} signal=${signal}`);
    // Whatever claude left behind is in its group: sweep it, as the host did.
    killGroup('SIGKILL');
    // ...and whatever left the group.
    const stragglers = killTagged(turnTag);
    if (stragglers.length > 0)
      log(`killed ${stragglers.length} stray process(es): ${stragglers.join(' ')}`);
    closeSync(inFd);
    for (const c of live) send(c, { t: 'exit', ...exited });
    server.close();
    if (existsSync(sockPath)) unlinkSync(sockPath);
    // Let the exit frame reach a connected host before going.
    const pending = [...clients].map(
      (c) => new Promise<void>((resolve) => (c.destroyed ? resolve() : c.end(resolve))),
    );
    const done = (): void => {
      closeSync(outFd);
      process.exit(0);
    };
    void Promise.all(pending).then(done);
    setTimeout(done, 2000).unref();
  });
}
