// UpdateBanner: the one prompt Patch ever shows about updating (spec/11 §
// One update switch). Two separate things can be newer than what this window runs: the
// desktop shell (a build it has downloaded) and the page (a deploy that landed
// while the window was open). The user never needs to know which. There is one
// sentence and one "Restart" button, and pressing it does whatever is needed:
// relaunch the shell into its staged build, which loads the new page too, or
// reload the page.
//
// Hosts and the server never prompt. With auto-update on they update in the
// background; with it off nothing moves until "Update everything" in Settings.
// Not dismissible and never on a timer: ignoring it is a supported outcome.

import { useEffect, useRef, useState, type JSX } from 'react';
import {
  getDesktopBridge,
  useDesktopUpdaterState,
  useLogUpdateBanner,
} from '../lib/desktopBridge.js';
import { reloadNow } from '../lib/liveUpdate.js';
import { useWebUpdateStore } from '../stores/webUpdateStore.js';

export const UPDATE_READY_TITLE = 'A new version of Patch is ready.';
export const UPDATE_READY_DETAIL = 'Restarting takes a few seconds, and your chats keep running.';
export const UPDATE_FAILED_TITLE = "Patch didn't restart.";

/** What to do after a failed restart, for where this window is running. */
export function failedDetail(where: 'mac' | 'desktop' | 'browser'): string {
  if (where === 'browser') return 'To finish updating, refresh this page. Your chats keep running.';
  if (where === 'mac')
    return 'To finish updating, quit Patch with ⌘Q and open it again. Your chats keep running.';
  return 'To finish updating, quit Patch and open it again. Your chats keep running.';
}

/**
 * Mirrors `updateUrgency` in packages/desktop/src/updater.ts: the dot goes from
 * quiet to amber to red the longer an update waits. Duplicated rather than
 * imported because the web bundle must not depend on the desktop package.
 */
const URGENCY_DUE_MS = 8 * 60 * 60 * 1000;
const URGENCY_OVERDUE_MS = 3 * 24 * 60 * 60 * 1000;
/** The shell's own install watchdog reports within this; past it, say it failed. */
const SHELL_GRACE_MS = 60_000;
/** A reload that is vetoed or swallowed leaves the button looking dead. */
const RELOAD_GRACE_MS = 8_000;

export type UpdateUrgency = 'none' | 'ready' | 'due' | 'overdue';

export function updateUrgency(staleSince: string | null, now: number): UpdateUrgency {
  if (staleSince === null) return 'none';
  const since = Date.parse(staleSince);
  if (Number.isNaN(since)) return 'ready';
  const age = now - since;
  if (age >= URGENCY_OVERDUE_MS) return 'overdue';
  if (age >= URGENCY_DUE_MS) return 'due';
  return 'ready';
}

function earliest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function whereRunning(hasShell: boolean): 'mac' | 'desktop' | 'browser' {
  if (!hasShell) return 'browser';
  return /Mac/i.test(navigator.platform) ? 'mac' : 'desktop';
}

export function UpdateBanner(): JSX.Element | null {
  const shell = useDesktopUpdaterState();
  const webStaleSince = useWebUpdateStore((s) => s.staleSince);
  const [now, setNow] = useState(() => Date.now());
  const [pressed, setPressed] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const shellStaged = shell !== null && shell.downloaded && !!shell.availableVersion;
  const shellInstallError =
    shell?.lastResult === 'error' && shell.lastErrorKind === 'install' ? shell.lastError : null;
  // The shell is still fetching its own build for this same deploy. Pressing now
  // would only reload the page, then the banner would come back for the shell:
  // two presses for one update. Hold until the shell has either staged its
  // build (one Restart does both) or settled without one (reload is all there is).
  const shellPending =
    shell === null
      ? getDesktopBridge()?.getUpdaterState !== undefined
      : !shellStaged &&
        shell.disabledReason === null &&
        (shell.checking || shell.lastResult === 'update-available');
  const staleSince = earliest(shellStaged ? (shell?.staleSince ?? null) : null, webStaleSince);
  const urgency = shellStaged || webStaleSince !== null ? updateUrgency(staleSince, now) : 'none';
  // A refused install must never be swallowed, even once nothing is staged.
  const shown = (urgency !== 'none' && !shellPending) || shellInstallError !== null;

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5 * 60_000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (shellInstallError === null) return;
    console.error(`update: the shell could not install its update: ${shellInstallError}`);
    window.clearTimeout(timer.current);
    setPressed(false);
    setFailed(true);
  }, [shellInstallError]);

  useLogUpdateBanner(
    getDesktopBridge() ? 'desktop' : 'web',
    shown ? (failed ? UPDATE_FAILED_TITLE : UPDATE_READY_TITLE) : null,
  );
  if (!shown) return null;

  const restart = (): void => {
    setFailed(false);
    setPressed(true);
    const giveUp = (ms: number): void => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        setPressed(false);
        setFailed(true);
      }, ms);
    };
    const bridge = getDesktopBridge();
    if (shellStaged && bridge?.installUpdate) {
      bridge.installUpdate();
      giveUp(SHELL_GRACE_MS);
      return;
    }
    try {
      reloadNow();
    } catch (err) {
      console.error('update: reload failed', err);
      setPressed(false);
      setFailed(true);
      return;
    }
    giveUp(RELOAD_GRACE_MS);
  };

  return (
    <div
      className={`desktop-update-banner ${failed ? 'failed' : urgency}`}
      data-testid="update-banner"
      data-urgency={urgency}
      // `status`, not `alert`: standing information that may stay for days.
      role="status"
    >
      <span className="dot" aria-hidden />
      <span className="desktop-update-text">
        <b>{failed ? UPDATE_FAILED_TITLE : UPDATE_READY_TITLE}</b>{' '}
        <span className="desktop-update-detail" data-testid="update-banner-detail">
          {failed ? failedDetail(whereRunning(getDesktopBridge() !== null)) : UPDATE_READY_DETAIL}
        </span>
      </span>
      <button
        type="button"
        className="desktop-update-restart"
        data-testid="update-banner-restart"
        disabled={pressed}
        onClick={restart}
      >
        {pressed ? 'Restarting…' : failed ? 'Try again' : 'Restart'}
      </button>
    </div>
  );
}
