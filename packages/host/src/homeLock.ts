// One host per patch home. The healthz port is the other single-instance lock,
// but it is configurable: a second host started with a different port shares
// ~/.patch with the first and both append to the same chat history logs, which
// tears records (a line that begins mid-record). This lock is keyed on the home
// directory itself, so no port choice can get round it.

import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
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

// A host that has just created the lock writes its pid a moment later; an empty
// file younger than this may be that, not a leftover.
const FRESH_MS = 2000;

export function acquireHomeLock(
  patchHome: string,
  log: (msg: string) => void = (m) => console.error(m),
): HomeLock {
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
    const text = readFileSync(path, 'utf8');
    const pid = Number(text.trim());
    if (!Number.isInteger(pid) || pid <= 0) {
      // Empty or garbled with no pid to be alive: left by a crash (a full disk
      // truncates it). Replace it, unless it was only just created.
      if (Date.now() - statSync(path).mtimeMs < FRESH_MS) {
        throw new Error(`${path} was just created by another host; try again`);
      }
      log(
        `${path} was unreadable (${JSON.stringify(text)}); treating it as stale and replacing it`,
      );
      unlinkSync(path);
      continue;
    }
    if (alive(pid)) {
      throw new Error(`another patch host (pid ${pid}) is already running on ${patchHome}`);
    }
    unlinkSync(path);
  }
  throw new Error(`could not take ${path}`);
}
