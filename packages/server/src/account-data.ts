// Each account's data in its own folder (spec/01 § Data folder).
//
// The data folder holds two kinds of thing. What belongs to the server itself
// stays at its top: the registry (which names the account and its hosts and
// surfaces), the internal token, the relay identity, the release channel, the
// update request, the admin pairing credential, the announced app build, and
// the diagnostics the server reports to the project (crash reports, the issue
// filer's state). Everything else belongs to the account and lives in
// `accounts/<folder>/`: chat records and the chat index, held and queued
// messages, drafts and attachments, jobs, hooks, settings and secrets, pads,
// artifacts and the rest. `accounts.json` says which folder is which account's.
// The whole data folder stays one self-contained folder (decision 3): moving
// the server is still carrying it across.
//
// A server that kept the old flat layout is moved over once, at start, before
// anything opens a file. The move is instant and safe to interrupt at any
// point; the next start runs on from where it stopped:
//
//   move  Each of the account's entries is renamed into `accounts/<folder>/`.
//         A rename within one filesystem is atomic, so an entry is always at
//         its old path or its new one, never half of each, and nothing is
//         copied: a large data folder moves as fast as a small one. Only when
//         the rename fails because the account folder is on another
//         filesystem (EXDEV) is the entry copied instead — copied, flushed,
//         compared file by file with the original, put in place, and only
//         then the original deleted.
//   link  A symlink is left at each old path pointing into the account folder,
//         so a build from before this layout run on the folder (a rollback)
//         reads and writes the same data instead of starting empty. This
//         build ignores the links. Then `accounts.json` is written.
//
// `account-migration.json` records the phase. A copy that does not match its
// original stops the server with the difference named and leaves the original
// where it is — never a server that starts on half its data.

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';

export const ACCOUNTS_DIR = 'accounts';
export const ACCOUNTS_FILE = 'accounts.json';
export const MIGRATION_JOURNAL = 'account-migration.json';

/**
 * What stays at the top of the data folder: the server's own files. A temp
 * file one of them leaves mid-write (`registry.json.tmp`) stays with it.
 */
export const SERVER_ENTRIES: ReadonlySet<string> = new Set([
  'registry.json',
  'internal.token',
  'relay.key',
  'release-channel',
  'update-all.json',
  'admin.credential',
  'announced-apk.json',
  'client-crashes.jsonl',
  'issue-reporting.json',
  'issue-filer-state.json',
  ACCOUNTS_DIR,
  ACCOUNTS_FILE,
  MIGRATION_JOURNAL,
]);

interface AccountsFile {
  version: 1;
  accounts: Array<{ folder: string; accountId: string | null }>;
}

type Phase = 'move' | 'link';

interface Journal {
  folder: string;
  entries: string[];
  phase: Phase;
}

function isServerEntry(name: string): boolean {
  if (SERVER_ENTRIES.has(name)) return true;
  for (const kept of SERVER_ENTRIES) {
    if (name.startsWith(`${kept}.`)) return true;
  }
  return false;
}

/** Write a small JSON file atomically and durably (temp file, fsync, rename). */
function writeJsonDurable(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  const fd = openSync(tmp, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function readJson<T>(path: string, what: string): T | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`${what} (${path}) is not readable JSON: ${(err as Error).message}`);
  }
}

function readAccounts(dataDir: string): AccountsFile | null {
  const file = readJson<AccountsFile>(join(dataDir, ACCOUNTS_FILE), ACCOUNTS_FILE);
  if (file === null) return null;
  if (file.version !== 1 || !Array.isArray(file.accounts) || file.accounts.length === 0) {
    throw new Error(`${ACCOUNTS_FILE} in ${dataDir} names no account folder`);
  }
  for (const a of file.accounts) {
    if (typeof a.folder !== 'string' || !/^[a-z0-9]+$/.test(a.folder)) {
      throw new Error(`${ACCOUNTS_FILE} in ${dataDir} has an unusable folder name`);
    }
  }
  return file;
}

/** The account id the registry holds, if it has one yet. */
function registryAccountId(dataDir: string): string | null {
  const reg = readJson<{ account?: { accountId?: unknown } | null }>(
    join(dataDir, 'registry.json'),
    'registry.json',
  );
  const id = reg?.account?.accountId;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** fsync every file and directory under `path`, so a copy survives a power cut. */
function fsyncTree(path: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) fsyncTree(join(path, name));
  }
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** One line per file, directory and link under `path`: what a faithful copy must match. */
function describeTree(path: string, rel = ''): string[] {
  const st = lstatSync(path);
  const mode = (st.mode & 0o777).toString(8);
  if (st.isSymbolicLink()) return [`${rel} link ${readlinkSync(path)}`];
  if (st.isDirectory()) {
    const out = [`${rel} dir ${mode}`];
    for (const name of readdirSync(path).sort()) {
      out.push(...describeTree(join(path, name), `${rel}/${name}`));
    }
    return out;
  }
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
  return [`${rel} file ${mode} ${st.size} ${hash}`];
}

/** Throw, naming the first difference, unless `copy` matches `original` exactly. */
function verifyCopy(original: string, copy: string): void {
  const a = describeTree(original);
  const b = describeTree(copy);
  const at = a.findIndex((line, i) => line !== b[i]);
  if (at !== -1 || a.length !== b.length) {
    const i = at === -1 ? Math.min(a.length, b.length) : at;
    throw new Error(
      `account data move: the copy ${copy} does not match ${original} at ${a[i] ?? b[i] ?? '(end)'}`,
    );
  }
}

/**
 * Test seam: called at each point the move could be cut off, so a test can
 * stop it there (by throwing) and start again, as a crash and restart would.
 */
let checkpoint: ((point: string) => void) | null = null;
export function __setMigrationCheckpoint(fn: ((point: string) => void) | null): void {
  checkpoint = fn;
}

/** Test seam: how an entry is renamed into the account folder (to make it fail with EXDEV). */
let renameEntry: (from: string, to: string) => void = renameSync;
export function __setEntryRename(fn: ((from: string, to: string) => void) | null): void {
  renameEntry = fn ?? renameSync;
}

/** Where the link left at an entry's old path points, relative to the data folder. */
function linkTarget(folder: string, name: string): string {
  return `${ACCOUNTS_DIR}/${folder}/${name}`;
}

/** True when `path` is the link this layout leaves at an old path. */
function isOldPathLink(path: string, folder: string, name: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && readlinkSync(path) === linkTarget(folder, name);
  } catch {
    return false;
  }
}

function mintFolder(): string {
  return randomBytes(6).toString('hex');
}

/**
 * Make sure this data folder is in the per-account layout, moving a flat one
 * over first, and return the account's folder. Runs before anything else opens
 * a file in the data folder.
 */
export function prepareAccountData(dataDir: string, log?: Logger): string {
  let journal = readJson<Journal>(join(dataDir, MIGRATION_JOURNAL), MIGRATION_JOURNAL);
  const accountId = registryAccountId(dataDir);

  if (journal === null) {
    const accounts = readAccounts(dataDir);
    if (accounts !== null) return openAccount(dataDir, accounts, accountId, log);
    const entries = readdirSync(dataDir)
      .filter((name) => !isServerEntry(name))
      .sort();
    const folder = mintFolder();
    if (entries.length === 0) {
      // A new server, or one that had nothing of the account's yet.
      mkdirSync(join(dataDir, ACCOUNTS_DIR, folder), { recursive: true, mode: 0o700 });
      writeJsonDurable(join(dataDir, ACCOUNTS_FILE), {
        version: 1,
        accounts: [{ folder, accountId }],
      } satisfies AccountsFile);
      return join(dataDir, ACCOUNTS_DIR, folder);
    }
    journal = { folder, entries, phase: 'move' };
    writeJsonDurable(join(dataDir, MIGRATION_JOURNAL), journal);
    log?.warn(
      { entries: entries.length, folder },
      'moving the account data into its own folder (spec/01 § Data folder)',
    );
  } else {
    log?.warn(
      { phase: journal.phase, folder: journal.folder },
      'resuming the move of the account data into its own folder',
    );
  }

  runMigration(dataDir, journal, accountId, log);
  return join(dataDir, ACCOUNTS_DIR, journal.folder);
}

function openAccount(
  dataDir: string,
  accounts: AccountsFile,
  accountId: string | null,
  log: Logger | undefined,
): string {
  // The server has one account (spec/01 § Account + host registry).
  const entry = accounts.accounts[0] as AccountsFile['accounts'][number];
  if (entry.accountId !== null && accountId !== null && entry.accountId !== accountId) {
    throw new Error(
      `the account folder ${ACCOUNTS_DIR}/${entry.folder} belongs to a different account than this server's registry; refusing to start on another account's data`,
    );
  }
  const dir = join(dataDir, ACCOUNTS_DIR, entry.folder);
  if (!existsSync(dir)) {
    throw new Error(`${ACCOUNTS_FILE} names ${ACCOUNTS_DIR}/${entry.folder}, which does not exist`);
  }
  // Account files at the top of a data folder already moved over were written
  // there by something that predates this layout (an older build run on it).
  // Nothing reads them; say so rather than let them pass unnoticed.
  // The links left at the old paths for a rollback are not stray.
  const stray = readdirSync(dataDir).filter(
    (name) => !isServerEntry(name) && !isOldPathLink(join(dataDir, name), entry.folder, name),
  );
  if (stray.length > 0) {
    log?.error(
      { stray },
      `account files at the top of the data folder are not read: the account's data is in ${ACCOUNTS_DIR}/${entry.folder}`,
    );
  }
  if (entry.accountId === null && accountId !== null) {
    // The account was set up after its folder was made: record whose it is.
    writeJsonDurable(join(dataDir, ACCOUNTS_FILE), {
      ...accounts,
      accounts: [{ ...entry, accountId }, ...accounts.accounts.slice(1)],
    } satisfies AccountsFile);
  }
  return dir;
}

function runMigration(
  dataDir: string,
  journal: Journal,
  accountId: string | null,
  log: Logger | undefined,
): void {
  const target = join(dataDir, ACCOUNTS_DIR, journal.folder);
  const setPhase = (phase: Phase): void => {
    journal.phase = phase;
    writeJsonDurable(join(dataDir, MIGRATION_JOURNAL), journal);
  };

  if (journal.phase === 'move') {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const name of journal.entries) {
      moveEntry(dataDir, target, name, log);
      checkpoint?.(`moved ${name}`);
    }
    fsyncTree(target);
    setPhase('link');
  }

  for (const name of journal.entries) {
    const old = join(dataDir, name);
    if (isOldPathLink(old, journal.folder, name)) continue;
    if (existsSync(old) || isSymlink(old)) {
      throw new Error(`account data move: ${old} should be free for its link but is not`);
    }
    symlinkSync(linkTarget(journal.folder, name), old);
    checkpoint?.(`linked ${name}`);
  }
  writeJsonDurable(join(dataDir, ACCOUNTS_FILE), {
    version: 1,
    accounts: [{ folder: journal.folder, accountId }],
  } satisfies AccountsFile);
  checkpoint?.('accounts written');
  rmSync(join(dataDir, MIGRATION_JOURNAL), { force: true });
  log?.info({ folder: journal.folder }, 'the account data is in its own folder');
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Put one entry in the account folder. Rerun after an interruption, it finds
 * the entry in exactly one place (or, after an EXDEV copy that was put in
 * place, verified in both) and carries on.
 */
function moveEntry(dataDir: string, target: string, name: string, log: Logger | undefined): void {
  const from = join(dataDir, name);
  const to = join(target, name);
  const partial = `${to}.partial`;
  const atOld = existsSync(from);
  const atNew = existsSync(to);
  if (atNew && !atOld) return;
  if (atNew && atOld) {
    // Only a cross-filesystem copy is ever in both places, and it was compared
    // with the original before it was put in place: the original can go.
    rmSync(from, { recursive: true, force: true });
    return;
  }
  if (!atOld) {
    throw new Error(`account data move: ${name} is neither in ${dataDir} nor in ${target}`);
  }
  try {
    renameEntry(from, to);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }
  log?.warn({ entry: name }, 'the account folder is on another filesystem: copying this entry');
  rmSync(partial, { recursive: true, force: true });
  cpSync(from, partial, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    errorOnExist: true,
  });
  checkpoint?.(`copying ${name}`);
  fsyncTree(partial);
  verifyCopy(from, partial);
  checkpoint?.(`copied ${name}`);
  renameSync(partial, to);
  checkpoint?.(`placed ${name}`);
  rmSync(from, { recursive: true, force: true });
}
