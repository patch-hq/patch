// Keeps macOS awake while a turn is in flight. A sleeping Mac suspends the
// host mid-request and the Claude Code call dies with "your computer went to
// sleep mid-response". One shared `caffeinate` child covers every concurrent
// turn: `-i` blocks idle sleep, `-s` blocks system sleep on AC, and `-w <pid>`
// makes it exit by itself if the daemon dies without releasing.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { Logger } from 'pino';

export interface SleepGuard {
  /** Hold the machine awake. Returns a release function; calling it twice is a no-op. */
  acquire(): () => void;
}

export interface SleepGuardOptions {
  logger: Logger;
  platform?: NodeJS.Platform;
  pid?: number;
  spawn?: (cmd: string, args: string[]) => Pick<ChildProcess, 'kill' | 'on'>;
}

export function createSleepGuard(opts: SleepGuardOptions): SleepGuard {
  const platform = opts.platform ?? process.platform;
  // Only macOS sleeps out from under a running process in this way.
  if (platform !== 'darwin') return { acquire: () => () => undefined };
  const spawn = opts.spawn ?? ((cmd, args) => nodeSpawn(cmd, args, { stdio: 'ignore' }));
  const pid = opts.pid ?? process.pid;
  let holders = 0;
  let child: Pick<ChildProcess, 'kill' | 'on'> | null = null;

  return {
    acquire() {
      holders += 1;
      if (child === null) {
        const c = spawn('/usr/bin/caffeinate', ['-i', '-s', '-w', String(pid)]);
        c.on('error', (err) => {
          opts.logger.error({ err }, 'sleep guard: caffeinate failed — the Mac may sleep mid-turn');
          if (child === c) child = null;
        });
        c.on('exit', () => {
          if (child === c) child = null;
        });
        child = c;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holders -= 1;
        if (holders === 0 && child !== null) {
          const c = child;
          child = null;
          c.kill();
        }
      };
    },
  };
}
