// Where the host was launched from, remembered across starts.
//
// Anything outside Patch that allow-lists the host by path (a process killer, a
// firewall rule, a TCC grant) goes stale the moment an update moves the
// executable, and the host then gets killed or blocked with no obvious cause.
// So each start compares its executable with the one recorded last time and
// says so out loud when they differ.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LaunchPathChange {
  previous: string;
  current: string;
}

export function launchPathFile(patchHome: string): string {
  return join(patchHome, 'launch-path.json');
}

/**
 * Record `current` as the host's launch path and return the change from the
 * recorded one, or undefined when it is the first start or nothing moved.
 */
export function checkLaunchPath(patchHome: string, current: string): LaunchPathChange | undefined {
  const file = launchPathFile(patchHome);
  let previous: string | undefined;
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { path?: unknown };
    if (typeof parsed.path !== 'string' || parsed.path === '') {
      throw new Error(`${file}: missing "path" — delete the file to record a fresh launch path`);
    }
    previous = parsed.path;
  }
  if (previous !== current) {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ path: current })}\n`);
    renameSync(tmp, file);
  }
  return previous !== undefined && previous !== current ? { previous, current } : undefined;
}
