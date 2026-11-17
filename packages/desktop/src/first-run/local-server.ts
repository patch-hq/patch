// The server this Mac runs for itself (spec/05 § Desktop first run, "On this
// Mac"). The release the app carries is started exactly as the box's installer
// starts one — through its own launcher, against a home of its own — with the
// app's bundled Node, listening on loopback only. The page the window loads and
// the host on this Mac both talk to it there; a phone reaches it through the
// relay (`PATCH_RELAY_URL`).

import { spawn, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

export interface LocalServerOptions {
  /** The server release the app carries (`patch-server`, `server/`, `web/`, `build-info.json`). */
  releaseDir: string;
  /** Where this server keeps everything: `data/`, `downloads/`, `logs/`. */
  home: string;
  port: number;
  /** Lets a phone reach this server (`ws(s)://` address of a relay). */
  relayUrl?: string;
  /** Host builds to serve from `downloads/`, for the host on this Mac to install from. */
  hostArtifacts?: string;
  /** The Node that runs it: in Electron, the app's own with `ELECTRON_RUN_AS_NODE`. */
  node: { execPath: string; env: Record<string, string> };
  startTimeoutMs?: number;
}

export interface LocalServer {
  origin: string;
  /** Stops the server this call started; one that was already running is left alone. */
  stop(): Promise<void>;
}

/**
 * A port nothing is listening on, to keep for good once chosen. Drawn from
 * below the OS's ephemeral range (Linux 32768+, macOS 49152+): the kernel hands
 * ephemeral ports to every outbound connection, so one probed free there can be
 * taken before the server binds it.
 */
export function freePort(): Promise<number> {
  const tryPort = (left: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const port = 20000 + Math.floor(Math.random() * 10000);
      const probe = createServer();
      probe.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' && left > 0) tryPort(left - 1).then(resolve, reject);
        else reject(e);
      });
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(port)));
    });
  return tryPort(20);
}

async function healthz(origin: string): Promise<{ gitSha?: string } | null> {
  try {
    const res = await fetch(`${origin}/api/healthz`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? ((await res.json()) as { gitSha?: string }) : null;
  } catch {
    return null;
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** The pid a previous app instance recorded for the server it started, if it is still running. */
function leftoverPid(pidFile: string): number | null {
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  return Number.isInteger(pid) && pid > 1 && alive(pid) ? pid : null;
}

/** Stop a server left by a previous app instance and wait for its port to go quiet. */
async function stopLeftover(pid: number, origin: string, port: number): Promise<void> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const wait = async (ms: number): Promise<boolean> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!alive(pid) && (await healthz(origin)) === null) return true;
      await sleep(100);
    }
    return false;
  };
  try {
    process.kill(pid, 'SIGTERM');
    if (await wait(5000)) return;
    process.kill(pid, 'SIGKILL');
  } catch (e) {
    throw new Error(
      `A Patch server left by an earlier launch (pid ${pid}) is holding port ${port} and could not be stopped: ${(e as Error).message}. Quit it and relaunch.`,
    );
  }
  if (await wait(3000)) return;
  throw new Error(
    `A Patch server left by an earlier launch (pid ${pid}) is still holding port ${port} after being killed. Quit it and relaunch.`,
  );
}

function tail(file: string, lines = 15): string {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

/** Copy each file in `from` into `to` unless an identical-size copy is already there. */
function seed(from: string, to: string): void {
  if (!existsSync(from)) {
    throw new Error(
      `This build of Patch carries no host builds (${from} is missing), so it cannot set up a host on this Mac.`,
    );
  }
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dest = join(to, name);
    if (statSync(src).isDirectory()) cpSync(src, dest, { recursive: true });
    else if (!existsSync(dest) || statSync(dest).size !== statSync(src).size)
      copyFileSync(src, dest);
  }
}

export async function startLocalServer(opts: LocalServerOptions): Promise<LocalServer> {
  const launcher = join(opts.releaseDir, 'patch-server');
  if (!existsSync(launcher))
    throw new Error(`There is no server release at ${opts.releaseDir} (no patch-server launcher).`);
  const origin = `http://127.0.0.1:${opts.port}`;
  const ourSha = (
    JSON.parse(readFileSync(join(opts.releaseDir, 'build-info.json'), 'utf8')) as { gitSha: string }
  ).gitSha;

  for (const d of ['data', 'downloads', 'logs']) mkdirSync(join(opts.home, d), { recursive: true });
  if (opts.hostArtifacts) seed(opts.hostArtifacts, join(opts.home, 'downloads'));

  const pidFile = join(opts.home, 'server.pid');
  let running = await healthz(origin);
  if (running !== null) {
    // Answering, and we recorded starting it: a previous app instance died without
    // stopping it. Replace it rather than inherit a server nobody can stop.
    const pid = leftoverPid(pidFile);
    if (pid !== null) {
      await stopLeftover(pid, origin, opts.port);
      running = await healthz(origin);
    }
  }
  if (running !== null) {
    if (running.gitSha !== ourSha) {
      throw new Error(
        `Port ${opts.port} is already answering as a different Patch server (build ${running.gitSha}, this app carries ${ourSha}). Quit that one first.`,
      );
    }
    return { origin, stop: async () => undefined };
  }

  const logFile = join(opts.home, 'logs', 'server.log');
  const log = openSync(logFile, 'a');
  const child: ChildProcess = spawn('/bin/sh', [launcher], {
    stdio: ['ignore', log, log],
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: process.env['HOME'] ?? opts.home,
      ...opts.node.env,
      PATCH_SERVER_HOME: opts.home,
      PATCH_NODE: opts.node.execPath,
      PORT: String(opts.port),
      HOST: '127.0.0.1',
      ...(opts.relayUrl ? { PATCH_RELAY_URL: opts.relayUrl } : {}),
    },
  });
  if (child.pid) writeFileSync(pidFile, String(child.pid));
  let exited: number | null | undefined;
  child.once('exit', (code) => {
    exited = code;
    rmSync(pidFile, { force: true });
  });
  child.once('error', (e) => {
    exited = -1;
    process.stderr.write(`[patch] could not start the server: ${e.message}\n`);
  });

  const stop = async (): Promise<void> => {
    if (exited !== undefined) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      child.kill('SIGTERM');
    });
  };

  const deadline = Date.now() + (opts.startTimeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    if (exited !== undefined) {
      throw new Error(
        `The server exited (${exited}) while starting. The end of ${logFile}:\n${tail(logFile)}`,
      );
    }
    if ((await healthz(origin)) !== null) return { origin, stop };
    await new Promise((r) => setTimeout(r, 100));
  }
  await stop();
  throw new Error(
    `The server did not answer on ${origin} within ${(opts.startTimeoutMs ?? 30_000) / 1000}s. The end of ${logFile}:\n${tail(logFile)}`,
  );
}
