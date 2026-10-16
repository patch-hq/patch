// One host per patch home. The healthz port is the other single-instance lock,
// but it is configurable: a second host started with a different port shares
// ~/.patch with the first and both append to the same chat history logs, which
// tears records (a line that begins mid-record). This lock is keyed on the home
// directory itself, so no port choice can get round it.

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export interface HomeLock {
  release(): void;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function acquireHomeLock(patchHome: string): HomeLock {
  const path = join(patchHome, 'daemon.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return {
        release() {
          try {
            if (Number(readFileSync(path, 'utf8')) === process.pid) unlinkSync(path);
          } catch {
            // already gone
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const pid = Number(readFileSync(path, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(
        `${path} is unreadable (${JSON.stringify(readFileSync(path, 'utf8'))}); remove it by hand`,
      );
    }
    if (alive(pid)) {
      throw new Error(`another patch host (pid ${pid}) is already running on ${patchHome}`);
    }
    unlinkSync(path);
  }
  throw new Error(`could not take ${path}`);
}
