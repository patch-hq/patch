// Each account's data in its own folder (spec/01 § Data folder), and the
// one-time move of a data folder from the old flat layout. Real files on disk;
// a "crash" is the move stopped at one of its checkpoints, followed by a fresh
// start exactly as the server would make one. Each entry is moved by rename;
// the copy that stands in for it across filesystems is driven by making the
// rename fail with EXDEV.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  readlinkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACCOUNTS_DIR,
  ACCOUNTS_FILE,
  MIGRATION_JOURNAL,
  __setEntryRename,
  __setMigrationCheckpoint,
  prepareAccountData,
} from '../src/account-data.js';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

const ACCOUNT_ID = 'acct-public-key';

/** What the account's files hold, by path relative to the folder they are in. */
const ACCOUNT_FILES: Record<string, string> = {
  'chat-logs/c1.jsonl': '{"seq":0,"type":"chat.user_message"}\n',
  'chat-logs/c2.jsonl': '{"seq":0}\n{"seq":1}\n',
  'chat-index.jsonl': '{"chatId":"c1"}\n',
  'settings.json': '{"theme":"dark"}',
  'secrets.json': '{"enc":"…"}',
  'secrets.key': 'k'.repeat(44),
  'jobs/nightly.json': '{"id":"nightly"}',
  'held-input.json': '[]',
  'tool-calls.jsonl': '{"tool":"patch_send_to"}\n',
  'attachments/c1/a1': 'binary-ish \u0000 bytes',
};
/** The server's own files, which stay where they are. */
const SERVER_FILES: Record<string, string> = {
  'registry.json': JSON.stringify({ account: { accountId: ACCOUNT_ID } }),
  'internal.token': 't'.repeat(32),
  'relay.key': 'relay',
  'release-channel': 'stable\n',
};

function write(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
}

function flatLayout(dir: string): void {
  write(dir, SERVER_FILES);
  write(dir, ACCOUNT_FILES);
  chmodSync(join(dir, 'secrets.key'), 0o600);
}

/** The folder `accounts.json` names. */
function accountFolder(dir: string): string {
  const file = JSON.parse(readFileSync(join(dir, ACCOUNTS_FILE), 'utf8')) as {
    accounts: Array<{ folder: string; accountId: string | null }>;
  };
  return join(dir, ACCOUNTS_DIR, file.accounts[0]!.folder);
}

/** The finished layout: server files on top, account files in the folder, nothing left over. */
function expectMoved(dir: string, folder: string): void {
  for (const [rel, body] of Object.entries(SERVER_FILES)) {
    expect(readFileSync(join(dir, rel), 'utf8')).toBe(body);
  }
  const name = folder.split('/').pop() as string;
  for (const [rel, body] of Object.entries(ACCOUNT_FILES)) {
    expect(readFileSync(join(folder, rel), 'utf8'), rel).toBe(body);
  }
  // Each old top-level path is a link into the account folder, nothing more.
  for (const top of ACCOUNT_ENTRIES) {
    expect(lstatSync(join(dir, top)).isSymbolicLink(), `${top} is a link`).toBe(true);
    expect(readlinkSync(join(dir, top))).toBe(`${ACCOUNTS_DIR}/${name}/${top}`);
  }
  expect(statSync(join(folder, 'secrets.key')).mode & 0o777).toBe(0o600);
  expect(existsSync(join(dir, MIGRATION_JOURNAL))).toBe(false);
  expect(readdirSync(join(dir, ACCOUNTS_DIR))).toEqual([name]);
  expect(readdirSync(folder).sort()).toEqual(ACCOUNT_ENTRIES);
  expect(readdirSync(dir).sort()).toEqual(
    [...Object.keys(SERVER_FILES), ...ACCOUNT_ENTRIES, ACCOUNTS_DIR, ACCOUNTS_FILE].sort(),
  );
}

/** The account's top-level entries. */
const ACCOUNT_ENTRIES = [
  ...new Set(Object.keys(ACCOUNT_FILES).map((p) => p.split('/')[0]!)),
].sort();

/** Make every entry rename fail as it would across filesystems. */
function crossFilesystem(): void {
  __setEntryRename(() => {
    throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
  });
}

/** Every checkpoint a clean move passes, in order. */
function checkpointsOfAMove(exdev = false): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'patch-acct-probe-'));
  const seen: string[] = [];
  try {
    flatLayout(dir);
    if (exdev) crossFilesystem();
    __setMigrationCheckpoint((p) => void seen.push(p));
    prepareAccountData(dir);
  } finally {
    __setMigrationCheckpoint(null);
    __setEntryRename(null);
    rmSync(dir, { recursive: true, force: true });
  }
  return seen;
}

describe('account data folders', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-acct-'));
  });

  afterEach(() => {
    __setMigrationCheckpoint(null);
    __setEntryRename(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a new server gets an empty account folder, and the same one on every start', () => {
    const first = prepareAccountData(dir);
    expect(statSync(first).isDirectory()).toBe(true);
    expect(first.startsWith(join(dir, ACCOUNTS_DIR))).toBe(true);
    expect(prepareAccountData(dir)).toBe(first);
  });

  it('records the account once the registry has one', () => {
    prepareAccountData(dir);
    write(dir, SERVER_FILES);
    prepareAccountData(dir);
    const file = JSON.parse(readFileSync(join(dir, ACCOUNTS_FILE), 'utf8')) as {
      accounts: Array<{ accountId: string | null }>;
    };
    expect(file.accounts[0]!.accountId).toBe(ACCOUNT_ID);
  });

  it("moves today's flat layout into the account's folder, byte for byte", () => {
    flatLayout(dir);
    const folder = prepareAccountData(dir);
    expect(folder).toBe(accountFolder(dir));
    expectMoved(dir, folder);
    // And a second start finds it done.
    expect(prepareAccountData(dir)).toBe(folder);
    expectMoved(dir, folder);
  });

  it('moves by rename: nothing is copied, and every entry is linked from its old path', () => {
    const points = checkpointsOfAMove();
    expect(points.filter((p) => p.startsWith('moved ')).length).toBe(ACCOUNT_ENTRIES.length);
    expect(points.filter((p) => p.startsWith('linked ')).length).toBe(ACCOUNT_ENTRIES.length);
    expect(points.some((p) => p.startsWith('copied '))).toBe(false);
    expect(points.at(-1)).toBe('accounts written');
  });

  it('copies, checks and then deletes each entry when the rename fails with EXDEV', () => {
    const points = checkpointsOfAMove(true);
    expect(points.filter((p) => p.startsWith('copied ')).length).toBe(ACCOUNT_ENTRIES.length);
    expect(points.filter((p) => p.startsWith('placed ')).length).toBe(ACCOUNT_ENTRIES.length);
    flatLayout(dir);
    crossFilesystem();
    expectMoved(dir, prepareAccountData(dir));
  });

  for (const exdev of [false, true]) {
    const how = exdev ? 'across filesystems' : 'by rename';
    for (const point of checkpointsOfAMove(exdev)) {
      it(`moving ${how}, a restart after it stopped at "${point}" finishes, losing nothing`, () => {
        flatLayout(dir);
        if (exdev) crossFilesystem();
        __setMigrationCheckpoint((p) => {
          if (p === point) throw new Error(`crash at ${p}`);
        });
        expect(() => prepareAccountData(dir)).toThrow(`crash at ${point}`);
        __setMigrationCheckpoint(null);

        const folder = prepareAccountData(dir);
        expectMoved(dir, folder);
      });
    }
  }

  it('a cross-filesystem copy that does not match stops the server and leaves the original', () => {
    flatLayout(dir);
    crossFilesystem();
    __setMigrationCheckpoint((p) => {
      if (p !== 'copying chat-logs') return;
      const { folder } = JSON.parse(readFileSync(join(dir, MIGRATION_JOURNAL), 'utf8')) as {
        folder: string;
      };
      writeFileSync(join(dir, ACCOUNTS_DIR, folder, 'chat-logs.partial', 'c1.jsonl'), 'damaged');
    });
    expect(() => prepareAccountData(dir)).toThrow(/does not match/);
    expect(readFileSync(join(dir, 'chat-logs', 'c1.jsonl'), 'utf8')).toBe(
      ACCOUNT_FILES['chat-logs/c1.jsonl'],
    );

    // Started again with nothing interfering, it copies afresh and finishes.
    __setMigrationCheckpoint(null);
    expectMoved(dir, prepareAccountData(dir));
  });

  it('says so when account files turn up at the top after the move', () => {
    flatLayout(dir);
    prepareAccountData(dir);
    // An old build replacing the link with a file of its own (a write by rename).
    rmSync(join(dir, 'chat-index.jsonl'));
    writeFileSync(join(dir, 'chat-index.jsonl'), '{}\n');
    const errors: unknown[] = [];
    const log = { error: (o: unknown) => void errors.push(o), warn: () => {}, info: () => {} };
    prepareAccountData(dir, log as never);
    // Only the file is flagged; the links beside it are the layout's own.
    expect(errors).toMatchObject([{ stray: ['chat-index.jsonl'] }]);
  });

  it('a build from before this layout reads and writes the moved data through the links', () => {
    flatLayout(dir);
    const folder = prepareAccountData(dir);
    // Reading the old paths, as an older build does.
    for (const [rel, body] of Object.entries(ACCOUNT_FILES)) {
      expect(readFileSync(join(dir, rel), 'utf8'), rel).toBe(body);
    }
    // Writing through them lands in the account folder.
    writeFileSync(join(dir, 'jobs', 'added-by-old-build.json'), '{"id":"x"}');
    writeFileSync(join(dir, 'held-input.json'), '[1]');
    expect(readFileSync(join(folder, 'jobs', 'added-by-old-build.json'), 'utf8')).toBe(
      '{"id":"x"}',
    );
    expect(readFileSync(join(folder, 'held-input.json'), 'utf8')).toBe('[1]');
    // And the new build, started again, takes no notice of the links.
    const errors: unknown[] = [];
    const log = { error: (o: unknown) => void errors.push(o), warn: () => {}, info: () => {} };
    expect(prepareAccountData(dir, log as never)).toBe(folder);
    expect(errors).toEqual([]);
  });

  it('refuses to start when the account folder it names is gone', () => {
    const folder = prepareAccountData(dir);
    rmSync(folder, { recursive: true });
    expect(() => prepareAccountData(dir)).toThrow(/does not exist/);
  });

  it("refuses to start on another account's folder", () => {
    flatLayout(dir);
    prepareAccountData(dir);
    writeFileSync(
      join(dir, 'registry.json'),
      JSON.stringify({ account: { accountId: 'someone-else' } }),
    );
    expect(() => prepareAccountData(dir)).toThrow(/different account/);
  });

  it('a server started on a flat data folder serves the same chats and history from the account folder', async () => {
    const CHAT = 'flat-chat';
    const user = generateUserKeypair(() => new Uint8Array(32).fill(7));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf',
      surfaceKind: 'terminal',
      label: 'cli',
      issuedAt: 1,
    });
    registry.setDaemonKey({ hostId: 'd1', publicKey: user.publicKey, issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf',
      surfaceKind: 'terminal',
      label: 'cli',
    });
    const headers = { authorization: `Bearer ${jwt}` };

    // A server writes a chat the ordinary way.
    const firstLink = new InProcessHostLink();
    const first = await buildAll({ logger: false, dataDir: dir, hostLink: firstLink });
    firstLink.emit({ type: 'chat.spawned', hostId: 'd1', chatId: CHAT, folder: '/work' });
    firstLink.emit({ type: 'chat.message', chatId: CHAT, role: 'user', content: 'kept', seq: 0 });
    await first.app.close();

    // Put its files back the way a server before per-account folders kept them.
    const folder = accountFolder(dir);
    for (const name of readdirSync(folder)) renameSync(join(folder, name), join(dir, name));
    rmSync(join(dir, ACCOUNTS_DIR), { recursive: true });
    rmSync(join(dir, ACCOUNTS_FILE));
    expect(existsSync(join(dir, 'chat-index.jsonl'))).toBe(true);

    const second = await buildAll({
      logger: false,
      dataDir: dir,
      hostLink: new InProcessHostLink(),
    });
    try {
      expect(existsSync(join(accountFolder(dir), 'chat-index.jsonl'))).toBe(true);
      expect(lstatSync(join(dir, 'chat-index.jsonl')).isSymbolicLink()).toBe(true);
      const get = await second.app.inject({ method: 'GET', url: `/api/chats/${CHAT}`, headers });
      expect(get.statusCode).toBe(200);
      expect(get.json()).toMatchObject({ chatId: CHAT, hostId: 'd1' });
      const hist = await second.app.inject({
        method: 'GET',
        url: `/api/chats/${CHAT}/history`,
        headers,
      });
      expect(JSON.stringify(hist.json())).toContain('kept');
    } finally {
      await second.app.close();
    }
  });
});
