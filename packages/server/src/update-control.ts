// One account-wide switch decides whether ANY part of Patch moves to a new
// release: the server, every host and the desktop app (spec/11 § One update switch).
//
// On: releases are mirrored and installed as they appear, the server first and
// the hosts behind it. Off: nothing moves. The mirror only notes which release
// is available, so the Updates page can offer it, until the user presses
// "Update everything". That request lifts the hold for one release, until the
// server and every online host are on it, then the hold returns.
//
// Because nothing moves alone, no part can fall behind the others while the
// switch is off.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REQUEST_FILE = 'update-all.json';
/** A request that never completes must not leave updates unheld for good. */
export const UPDATE_ALL_EXPIRES_MS = 2 * 60 * 60 * 1000;

interface UpdateAllRequest {
  requestedAt: number;
}

export interface UpdateControlOptions {
  dataDir: string | null;
  now?: () => number;
}

export class UpdateControl {
  private autoUpdate: () => boolean = () => true;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(private readonly opts: UpdateControlOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Wired by the app once account settings are loaded. */
  setAutoUpdate(read: () => boolean): void {
    this.autoUpdate = read;
  }

  isAutoUpdate(): boolean {
    return this.autoUpdate();
  }

  /** Whether releases may be mirrored, installed and pushed to hosts right now. */
  mayUpdate(): boolean {
    return this.autoUpdate() || this.updateAllPending();
  }

  updateAllPending(): boolean {
    const req = this.read();
    if (!req) return false;
    if (this.now() - req.requestedAt > UPDATE_ALL_EXPIRES_MS) {
      this.clearUpdateAll();
      return false;
    }
    return true;
  }

  /** "Update everything": lift the hold until everything is on the new release. */
  requestUpdateAll(): void {
    if (this.opts.dataDir) {
      const body: UpdateAllRequest = { requestedAt: this.now() };
      writeFileSync(join(this.opts.dataDir, REQUEST_FILE), JSON.stringify(body));
    }
    for (const fn of this.listeners) fn();
  }

  clearUpdateAll(): void {
    if (!this.opts.dataDir) return;
    rmSync(join(this.opts.dataDir, REQUEST_FILE), { force: true });
  }

  /** Called when an update is requested, so the mirror can check at once. */
  onUpdateAllRequested(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private read(): UpdateAllRequest | null {
    if (!this.opts.dataDir) return null;
    const file = join(this.opts.dataDir, REQUEST_FILE);
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<UpdateAllRequest>;
      return typeof parsed.requestedAt === 'number' ? { requestedAt: parsed.requestedAt } : null;
    } catch {
      return null;
    }
  }
}
