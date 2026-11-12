// Keeping Patch running on a computer that runs it itself (spec/05 § Keep
// running).
//
// When the app runs the server and host on this computer, the window is only
// one way in: the phone reaches the same server through the relay, and jobs and
// chats keep going with no one looking. So closing the window leaves the app in
// the menu bar, the app can open itself at login so a restart does not cut the
// phone off, and while the computer is on mains power it can be kept from
// sleeping — never the display, only the system — so the phone can still reach
// it. Both are on by default and both can be turned off, here and in Settings.
//
// Kept free of Electron so it can be tested under plain node: the shell hands
// in the pieces of Electron it drives.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface KeepRunningPrefs {
  openAtLogin: boolean;
  keepAwake: boolean;
}

export interface KeepRunningState extends KeepRunningPrefs {
  /** Whether the awake hold is in force right now. */
  holdingAwake: boolean;
  /**
   * Whether this app can open itself at login here. A Linux app not started
   * from its AppImage has no file a login entry could start, so it cannot.
   */
  canOpenAtLogin: boolean;
}

export const KEEP_RUNNING_DEFAULTS: KeepRunningPrefs = { openAtLogin: true, keepAwake: true };

/**
 * What the user chose, or the defaults when they have never chosen. A file that
 * is there and unreadable is an error naming it, not a quiet return to the
 * defaults: that would turn an "off" back on behind their back.
 */
export function readPrefs(file: string): KeepRunningPrefs {
  if (!existsSync(file)) return { ...KEEP_RUNNING_DEFAULTS };
  let parsed: Partial<Record<keyof KeepRunningPrefs, unknown>>;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as typeof parsed;
  } catch (e) {
    throw new Error(`${file} is not readable (${(e as Error).message}). Delete it to reset.`);
  }
  const out = { ...KEEP_RUNNING_DEFAULTS };
  for (const k of ['openAtLogin', 'keepAwake'] as const) {
    if (parsed[k] === undefined) continue;
    if (typeof parsed[k] !== 'boolean') throw new Error(`${file}: ${k} is not true or false`);
    out[k] = parsed[k];
  }
  return out;
}

export function writePrefs(file: string, prefs: KeepRunningPrefs): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(prefs, null, 2));
  renameSync(tmp, file);
}

/** The pieces of Electron this drives. */
export interface KeepRunningHost {
  /** False where nothing can start this app at login (see KeepRunningState). */
  canOpenAtLogin: boolean;
  setOpenAtLogin(on: boolean): void;
  onBattery(): boolean;
  /** Fires with `true` on battery and `false` on mains power. */
  onPowerSourceChange(cb: (battery: boolean) => void): void;
  /** `powerSaveBlocker.start('prevent-app-suspension')`: the system stays up, the display may sleep. */
  holdAwake(): number;
  releaseAwake(id: number): void;
}

export class KeepRunning {
  private prefs: KeepRunningPrefs;
  private blocker: number | null = null;

  constructor(
    private readonly file: string,
    private readonly host: KeepRunningHost,
  ) {
    this.prefs = readPrefs(file);
  }

  /** Apply the saved choices (or the defaults, which are then saved) and follow the power source. */
  start(): KeepRunningState {
    if (!existsSync(this.file)) writePrefs(this.file, this.prefs);
    if (this.host.canOpenAtLogin) this.host.setOpenAtLogin(this.prefs.openAtLogin);
    this.host.onPowerSourceChange(() => this.applyAwake());
    this.applyAwake();
    return this.state();
  }

  state(): KeepRunningState {
    return {
      ...this.prefs,
      // Never reported on where it cannot be: that would be a switch that does nothing.
      openAtLogin: this.host.canOpenAtLogin && this.prefs.openAtLogin,
      holdingAwake: this.blocker !== null,
      canOpenAtLogin: this.host.canOpenAtLogin,
    };
  }

  set(patch: Partial<KeepRunningPrefs>): KeepRunningState {
    if (patch.openAtLogin === true && !this.host.canOpenAtLogin) {
      throw new Error('Patch cannot open at login here: it was not started from its AppImage');
    }
    for (const k of ['openAtLogin', 'keepAwake'] as const) {
      const v = patch[k];
      if (v === undefined) continue;
      if (typeof v !== 'boolean') throw new Error(`${k} must be true or false`);
      this.prefs[k] = v;
    }
    writePrefs(this.file, this.prefs);
    if (patch.openAtLogin !== undefined) this.host.setOpenAtLogin(this.prefs.openAtLogin);
    this.applyAwake();
    return this.state();
  }

  /** Let the computer sleep again: the app is quitting. */
  stop(): void {
    if (this.blocker !== null) this.host.releaseAwake(this.blocker);
    this.blocker = null;
  }

  private applyAwake(): void {
    const want = this.prefs.keepAwake && !this.host.onBattery();
    if (want && this.blocker === null) this.blocker = this.host.holdAwake();
    if (!want && this.blocker !== null) {
      this.host.releaseAwake(this.blocker);
      this.blocker = null;
    }
  }
}

/**
 * Opening at login on Linux: an XDG autostart entry for the AppImage, which is
 * what desktops start at login. Electron's own login-item setting does nothing
 * there. The entry passes `--patch-opened-at-login`, so the app knows to start
 * in the tray with no window, as it does on a Mac.
 */
export const OPENED_AT_LOGIN_ARG = '--patch-opened-at-login';

export function autostartEntry(appImage: string): string {
  const exec = `"${appImage.replace(/(["`$\\])/g, '\\$1')}" ${OPENED_AT_LOGIN_ARG}`;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Patch',
    `Exec=${exec}`,
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

export function setLinuxAutostart(file: string, appImage: string, on: boolean): void {
  if (!on) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, autostartEntry(appImage));
  renameSync(tmp, file);
}
