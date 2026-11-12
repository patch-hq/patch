// Where the Mac app runs from, and what follows from it (spec/05 § Desktop
// first run, § Keep running).
//
// A new user often opens Patch straight from ~/Downloads or from the disk
// image. The first run offers to move it to Applications, and the login item
// is registered from wherever the app really is: macOS records the bundle's
// path when the item is registered, so an item registered from Downloads goes
// on pointing there after the app is moved, and one registered from the disk
// image or a quarantined download points at a path that is gone by the next
// login.
//
// Kept free of Electron so it can be tested under plain node.

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/**
 * A place the app runs from that will not be there at the next login: the
 * mounted disk image, or the read-only copy macOS runs a quarantined download
 * from (App Translocation).
 */
export function isTransientLocation(bundlePath: string): boolean {
  return bundlePath.startsWith('/Volumes/') || bundlePath.includes('/AppTranslocation/');
}

/** Whether to ask to move the app to Applications before the first-run question. */
export function shouldOfferMove(o: {
  platform: NodeJS.Platform;
  packaged: boolean;
  /** A quiet instance is a test run: it never asks anything of the person at the computer. */
  quiet: boolean;
  inApplications: boolean;
  /** No remembered connection: this launch is the first run. */
  firstRun: boolean;
}): boolean {
  return o.platform === 'darwin' && o.packaged && !o.quiet && !o.inApplications && o.firstRun;
}

/** Why the Mac app cannot open at login from here, or null when it can. */
export function macLoginItemBlocker(bundlePath: string): string | null {
  return isTransientLocation(bundlePath)
    ? 'Patch cannot open at login while it runs from the disk image or a quarantined download. Move it to Applications and open it from there.'
    : null;
}

/** The pieces of Electron the Mac login item is driven through. */
export interface MacLoginItemHost {
  /** The running bundle, e.g. /Applications/Patch.app. */
  bundlePath: string;
  /** Records which bundle path the item was last registered from. */
  recordFile: string;
  /** Whether macOS has the app as a login item at all. */
  registered(): boolean;
  register(): void;
  unregister(): void;
  warn(message: string): void;
  info(message: string): void;
}

/** The bundle path the login item was last registered from, if known. */
export function recordedLoginItemPath(file: string, warn: (m: string) => void): string | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { path?: unknown };
    if (typeof parsed.path === 'string') return parsed.path;
    warn(`${file} names no path; the login item is registered again`);
  } catch (e) {
    // Re-derivable: registering again rebuilds it, so a damaged record is not fatal.
    warn(`${file} is not readable (${(e as Error).message}); the login item is registered again`);
  }
  return null;
}

/**
 * Turn the login item on or off. On, it is registered from the running
 * bundle, and registered afresh when the app has moved since: an item macOS
 * already holds is not repointed by registering it again, so the old one is
 * removed first.
 */
export function applyMacLoginItem(on: boolean, host: MacLoginItemHost): void {
  if (!on) {
    host.unregister();
    rmSync(host.recordFile, { force: true });
    return;
  }
  const blocker = macLoginItemBlocker(host.bundlePath);
  if (blocker) throw new Error(blocker);
  const recorded = recordedLoginItemPath(host.recordFile, host.warn);
  if (recorded === host.bundlePath && host.registered()) return;
  host.unregister();
  host.register();
  if (!host.registered()) {
    // Not fatal to the app (the person may have turned Patch off in System
    // Settings → Login Items, which macOS then holds as needing approval), but
    // said, and nothing is recorded, so the next launch tries again.
    host.warn(
      `macOS did not add ${host.bundlePath} as a login item; check System Settings → General → Login Items`,
    );
    return;
  }
  const tmp = `${host.recordFile}.tmp`;
  writeFileSync(tmp, JSON.stringify({ path: host.bundlePath }));
  renameSync(tmp, host.recordFile);
  host.info(`registered from ${host.bundlePath}${recorded ? ` (was ${recorded})` : ''}`);
}
