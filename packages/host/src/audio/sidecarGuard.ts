// Lifetime helpers for the Python sidecars (whisper, kokoro) the host spawns.
//
// A sidecar from an earlier host process (parent died, reparented to init)
// keeps its loopback port. The next host's sidecar then exits on a bind error
// while requests go to the stale one. The host owns its sidecars: it reclaims
// the port before spawning and kills its children when it exits.

import { execFile, type ChildProcess } from 'node:child_process';
import type { Logger } from 'pino';

function listenerPids(port: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], (err, stdout) => {
      // lsof exits 1 with no output when nothing listens.
      if (err && (err as { code?: number }).code !== 1) {
        reject(new Error(`lsof failed checking port ${port}: ${err.message}`));
        return;
      }
      resolve(
        stdout
          .split('\n')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid),
      );
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Kill whatever listens on `port` (a stale sidecar) so a fresh spawn can bind it. */
export async function reclaimPort(port: number, name: string, logger: Logger): Promise<void> {
  const pids = await listenerPids(port);
  if (pids.length === 0) return;
  logger.warn({ port, pids }, `${name}: killing stale listener on sidecar port`);
  for (const pid of pids) process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 20; i++) {
    await sleep(100);
    if ((await listenerPids(port)).length === 0) return;
  }
  for (const pid of await listenerPids(port)) process.kill(pid, 'SIGKILL');
  await sleep(200);
  const left = await listenerPids(port);
  if (left.length > 0)
    throw new Error(`${name}: port ${port} still held by pid ${left.join(',')} after SIGKILL`);
}

const tracked = new Set<ChildProcess>();
let hooked = false;

/** Kill `proc` when the host process exits, so it can never be orphaned. */
export function killOnHostExit(proc: ChildProcess): void {
  tracked.add(proc);
  proc.once('exit', () => tracked.delete(proc));
  if (hooked) return;
  hooked = true;
  process.on('exit', () => {
    for (const p of tracked) if (!p.killed) p.kill('SIGKILL');
  });
}

/** Keep the last lines of a child's output so an exit can say why. */
export function tailOutput(proc: ChildProcess): () => string {
  let last = '';
  const tail = (buf: Buffer): void => {
    last = (last + buf.toString()).split('\n').slice(-8).join('\n');
  };
  proc.stdout?.on('data', tail);
  proc.stderr?.on('data', tail);
  return () => last.slice(-1200);
}
