import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
const run = promisify(execFile);
/** An install lock older than this was left by a process that died mid-install. */
const STALE_LOCK_MS = 10 * 60_000;
const LOCK_WAIT_MS = 5 * 60_000;
export const CODEX_VERSION = '0.154.0';
/** Pinned, managed runtime; never substitutes an arbitrary version from PATH. */
export class CodexRuntime {
  private installing: Promise<string> | undefined;
  constructor(
    private root: string,
    /** Installs the pinned package into `root`; npm unless a test stands in. */
    private installPackage: (root: string) => Promise<void> = npmInstall,
  ) {}
  get version(): string | null {
    const manifest = join(this.root, 'node_modules/@openai/codex/package.json');
    if (!existsSync(manifest) || !existsSync(this.executable)) return null;
    const version = JSON.parse(readFileSync(manifest, 'utf8')).version;
    return version === CODEX_VERSION ? version : null;
  }
  get executable(): string {
    return join(this.root, 'node_modules/.bin/codex');
  }
  ensure(): Promise<string> {
    if (this.version) return Promise.resolve(this.executable);
    if (!this.installing)
      this.installing = this.install().finally(() => {
        this.installing = undefined;
      });
    return this.installing;
  }
  /**
   * One install at a time per runtime directory, across PROCESSES: two npm
   * installs into the same prefix race each other's renames and one fails
   * (ENOTEMPTY). The in-process `installing` promise cannot see another
   * process, so the lock is a directory beside the runtime — `mkdir` is atomic.
   */
  private async withInstallLock<T>(fn: () => Promise<T>): Promise<T> {
    const lock = `${this.root}.install-lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        mkdirSync(lock);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        let age = 0;
        try {
          age = Date.now() - statSync(lock).mtimeMs;
        } catch {
          continue; // released between the mkdir and the stat: try again now
        }
        if (age > STALE_LOCK_MS) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(`Codex install is locked by another process (${lock})`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    try {
      return await fn();
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
  private async install(): Promise<string> {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    return this.withInstallLock(() => this.installLocked());
  }
  private async installLocked(): Promise<string> {
    // Another process may have installed it while this one waited.
    if (this.version) return this.executable;
    await this.installPackage(this.root);
    if (!this.version)
      throw new Error(`Codex ${CODEX_VERSION} installation did not produce its executable`);
    return this.executable;
  }
}

async function npmInstall(root: string): Promise<void> {
  await run(
    'npm',
    ['install', '--prefix', root, '--no-audit', '--no-fund', `@openai/codex@${CODEX_VERSION}`],
    { timeout: 180000, maxBuffer: 1024 * 1024 },
  );
}
