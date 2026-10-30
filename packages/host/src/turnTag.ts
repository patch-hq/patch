import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

/** Env var every process of a turn inherits, so the turn's tree can be found. */
export const TURN_TAG_ENV = 'PATCH_TURN_TAG';

export function newTurnTag(): string {
  return randomUUID();
}

/**
 * Kill every process that carries `tag` in its environment.
 *
 * The process-group kill (claudeSpawn.ts) misses anything that left claude's
 * group: a tool that calls setsid, a daemonised test runner. Those are
 * reparented to init the moment claude dies, which is how five vitest runs
 * outlived their turns and swamped the host. They still hold the environment
 * claude gave them, so the tag finds them wherever they went.
 *
 * Reads /proc, so Linux only; elsewhere it returns 0 and the group kill is
 * all there is. Returns the pids signalled.
 */
export function killTagged(tag: string, signal: NodeJS.Signals = 'SIGKILL'): number[] {
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const needle = `${TURN_TAG_ENV}=${tag}`;
  const killed: number[] = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    let environ: string;
    try {
      environ = readFileSync(`/proc/${pid}/environ`, 'latin1');
    } catch {
      continue; // exited, or not ours to read
    }
    if (!environ.split('\0').includes(needle)) continue;
    try {
      process.kill(pid, signal);
      killed.push(pid);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
    }
  }
  return killed;
}
