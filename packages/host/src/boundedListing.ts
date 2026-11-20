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

import { spawn } from 'node:child_process';

/** How long a read may wait on a person (a macOS permission dialog) before it is abandoned. */
export const LISTING_TIMEOUT_MS = 5 * 60_000;
/** How long a caller waits for a read before telling the person it is waiting on them. */
export const LISTING_WINDOW_MS = 1_200;

export type ListingResult =
  | { kind: 'ok'; names: string[] }
  | { kind: 'timeout' }
  /** Still running past the caller's window — almost certainly a permission dialog. */
  | { kind: 'pending' }
  /** macOS refused the read ("Don't Allow", or no grant). */
  | { kind: 'denied' }
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
      if (out === '' && code !== 0 && /operation not permitted/i.test(err))
        settle({ kind: 'denied' });
      else if (out === '' && code !== 0)
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

const inFlight = new Map<string, Promise<ListingResult>>();

/**
 * One read per directory at a time. A second caller (the picker retrying while
 * the dialog is open) joins the read already waiting rather than starting
 * another, and the read carries on after any one caller has stopped waiting.
 */
function listShared(dir: string): Promise<ListingResult> {
  let p = inFlight.get(dir);
  if (!p) {
    p = listChildDirs(dir).finally(() => inFlight.delete(dir));
    inFlight.set(dir, p);
  }
  return p;
}

/** The listing, or `pending` if it has not come back within `windowMs`. */
export async function listChildDirsWithin(
  dir: string,
  windowMs = LISTING_WINDOW_MS,
): Promise<ListingResult> {
  let timer: NodeJS.Timeout | undefined;
  const pending = new Promise<ListingResult>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'pending' }), windowMs);
  });
  try {
    return await Promise.race([listShared(dir), pending]);
  } finally {
    clearTimeout(timer);
  }
}

const folderName = (dir: string): string => dir.split('/').filter(Boolean).pop() ?? dir;

/** Folders macOS guards behind a permission dialog: the user's own, iCloud, and other volumes. */
export function isProtectedFolder(dir: string): boolean {
  return (
    /^\/Users\/[^/]+\/(Desktop|Documents|Downloads)(\/|$)/.test(dir) ||
    /^\/Users\/[^/]+\/Library\/(Mobile Documents|CloudStorage)(\/|$)/.test(dir) ||
    /^\/Volumes\//.test(dir)
  );
}

/** What to tell the person while a read has not come back. */
export function listingPendingMessage(dir: string): string {
  return isProtectedFolder(dir)
    ? `Waiting for you to allow access to ${folderName(dir)} in the macOS dialog`
    : `${folderName(dir)} is slow to open — still trying`;
}

/** What to tell the person when macOS refused. */
export function listingDeniedMessage(dir: string): string {
  return `macOS didn't allow Patch to open ${folderName(dir)}. Allow it in System Settings > Privacy & Security > Files & Folders, or choose another folder.`;
}

/** Timed out after the full wait with no answer at all. */
export function listingTimeoutMessage(dir: string): string {
  return `${folderName(dir)} did not open, and macOS never answered. Choose another folder.`;
}
