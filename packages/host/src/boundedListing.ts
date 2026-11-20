// Child-directory listing that can never wedge the host.
//
// On macOS the first read of ~/Documents, ~/Desktop or ~/Downloads by a
// background process raises a privacy (TCC) prompt, and the read blocks until
// someone answers it. A blocked `fs.readdir` parks a libuv threadpool thread
// for as long as that takes; a few of them exhaust the pool and every other
// fs, DNS and crypto call in the host stalls behind them. So the host never
// reads a user-chosen directory itself: it asks a short-lived `find` child to,
// and gives up on the child after a deadline. A stuck child costs one process,
// not the host.

import { execFile, spawn } from 'node:child_process';

export const LISTING_TIMEOUT_MS = 4_000;

export type ListingResult =
  | { kind: 'ok'; names: string[] }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string };

export type ListChildDirs = (dir: string, timeoutMs?: number) => Promise<ListingResult>;

/**
 * Names of the child directories of `dir` (symlinks to directories included),
 * read by a child process. Settles by the deadline whether or not the child
 * ever exits — a process stuck in a kernel permission wait may ignore SIGKILL,
 * so the result must not wait for its exit.
 */
export const listChildDirs: ListChildDirs = (dir, timeoutMs = LISTING_TIMEOUT_MS) =>
  new Promise((resolve) => {
    let settled = false;
    const settle = (r: ListingResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(
      'find',
      ['-L', dir, '-mindepth', '1', '-maxdepth', '1', '-type', 'd', '-print0'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      announcePermissionWait(dir);
      settle({ kind: 'timeout' });
    }, timeoutMs);
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (out += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (err += c));
    child.on('error', (e) => settle({ kind: 'error', message: e.message }));
    child.on('close', (code) => {
      // `find -L` exits 1 for an unreadable or dangling entry it skipped but
      // still lists the rest. It only fails outright when `dir` itself cannot
      // be read, which leaves nothing on stdout and a message on stderr.
      if (out === '' && code !== 0)
        settle({ kind: 'error', message: err.trim() || `exit ${code}` });
      else
        settle({
          kind: 'ok',
          names: out
            .split('\0')
            .filter((p) => p !== '')
            .map((p) => p.slice(dir.length).replace(/^\/+/, '')),
        });
    });
  });

/** Plain-language reason a listing timed out, for the person looking at the picker. */
export function listingTimeoutMessage(dir: string): string {
  const name = dir.split('/').filter(Boolean).pop() ?? dir;
  return `macOS is asking for permission to open ${name} — look for a dialog on the Mac, or choose another folder`;
}

const lastAnnounced = new Map<string, number>();
const ANNOUNCE_EVERY_MS = 60_000;

/**
 * The macOS privacy dialog is easy to miss behind other windows, so a listing
 * that is waiting on it also raises a system notification pointing at it.
 * Once a minute per folder; macOS only.
 */
export function announcePermissionWait(
  dir: string,
  opts: { platform?: NodeJS.Platform; now?: number; run?: typeof execFile } = {},
): boolean {
  if ((opts.platform ?? process.platform) !== 'darwin') return false;
  const now = opts.now ?? Date.now();
  if (now - (lastAnnounced.get(dir) ?? -Infinity) < ANNOUNCE_EVERY_MS) return false;
  lastAnnounced.set(dir, now);
  const name = dir.split('/').filter(Boolean).pop() ?? dir;
  const script = `display notification "Patch is waiting for permission to open ${name.replace(/[\\"]/g, '')}. Look for a macOS dialog and click Allow." with title "Patch needs your permission"`;
  (opts.run ?? execFile)('osascript', ['-e', script], { timeout: 5_000 }, (err) => {
    if (err) console.warn(`could not raise the permission notification: ${err.message}`);
  });
  return true;
}
