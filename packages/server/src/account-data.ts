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
// anything opens a file. The move is safe to interrupt at any point and simply
// runs on from where it was on the next start:
//
//   copy     The account's entries are copied into `accounts/<folder>.partial`,
//            flushed to disk, compared file by file with the originals, and
//            only then renamed into place. Nothing has been touched yet, so an
//            interrupted copy is thrown away and made again.
//   back up  The originals are renamed, one by one, into
//            `account-migration-backup/`. They are the backup.
//   verify   The account folder is compared with the backup again. Only once
//            it matches is `accounts.json` written.
//   clean    The backup is deleted.
//
// `account-migration.json` records the phase. A comparison that fails stops
// the server with the difference named and leaves every file where it is —
// never a server that starts on half its data.

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
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';

export const ACCOUNTS_DIR = 'accounts';
export const ACCOUNTS_FILE = 'accounts.json';
export const MIGRATION_JOURNAL = 'account-migration.json';
export const MIGRATION_BACKUP = 'account-migration-backup';

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
  MIGRATION_BACKUP,
]);

interface AccountsFile {
  version: 1;
  accounts: Array<{ folder: string; accountId: string | null }>;
}

type Phase = 'copy' | 'backup' | 'verify' | 'clean';

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

/** Throw, naming the first difference, unless every entry under `to` matches `from`. */
function verifyCopy(fromDir: string, toDir: string, entries: string[]): void {
  for (const name of entries) {
    const from = join(fromDir, name);
    const to = join(toDir, name);
    if (!existsSync(to)) {
      throw new Error(`account data move: ${name} is missing from ${toDir}`);
    }
    const a = describeTree(from, name);
    const b = describeTree(to, name);
    const at = a.findIndex((line, i) => line !== b[i]);
    if (at !== -1 || a.length !== b.length) {
      const i = at === -1 ? Math.min(a.length, b.length) : at;
      throw new Error(
        `account data move: ${toDir} does not match ${fromDir} at ${a[i] ?? b[i] ?? name}`,
      );
    }
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
    journal = { folder, entries, phase: 'copy' };
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
  const stray = readdirSync(dataDir).filter((name) => !isServerEntry(name));
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
  const accountsRoot = join(dataDir, ACCOUNTS_DIR);
  const target = join(accountsRoot, journal.folder);
  const partial = `${target}.partial`;
  const backup = join(dataDir, MIGRATION_BACKUP);
  const setPhase = (phase: Phase): void => {
    journal.phase = phase;
    writeJsonDurable(join(dataDir, MIGRATION_JOURNAL), journal);
  };

  if (journal.phase === 'copy') {
    // Nothing has moved yet: whatever an earlier attempt left is thrown away.
    rmSync(partial, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true, mode: 0o700 });
    for (const name of journal.entries) {
      const from = join(dataDir, name);
      if (!existsSync(from)) {
        throw new Error(`account data move: ${name} was listed to move but is not in ${dataDir}`);
      }
      cpSync(from, join(partial, name), {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
        errorOnExist: true,
      });
      checkpoint?.(`copied ${name}`);
    }
    fsyncTree(partial);
    verifyCopy(dataDir, partial, journal.entries);
    renameSync(partial, target);
    fsyncTree(accountsRoot);
    checkpoint?.('copy in place');
    setPhase('backup');
  }

  if (journal.phase === 'backup') {
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    for (const name of journal.entries) {
      // Moved already by an attempt that was cut off after this one.
      if (!existsSync(join(dataDir, name))) continue;
      renameSync(join(dataDir, name), join(backup, name));
      checkpoint?.(`backed up ${name}`);
    }
    fsyncTree(backup);
    setPhase('verify');
  }

  if (journal.phase === 'verify') {
    verifyCopy(backup, target, journal.entries);
    writeJsonDurable(join(dataDir, ACCOUNTS_FILE), {
      version: 1,
      accounts: [{ folder: journal.folder, accountId }],
    } satisfies AccountsFile);
    checkpoint?.('accounts written');
    setPhase('clean');
  }

  rmSync(backup, { recursive: true, force: true });
  checkpoint?.('backup removed');
  rmSync(join(dataDir, MIGRATION_JOURNAL), { force: true });
  log?.info({ folder: journal.folder }, 'the account data is in its own folder');
}
