// DesktopUpdateBanner — the shell has a newer build staged, and is waiting to
// be asked. Worded identically to WebUpdateBanner ("Patch has updated" /
// "Update Patch") so the user sees one prompt, not two kinds; only the action
// differs (restart into the new shell vs reload the bundle).
//
// This replaces the shell restarting itself the instant a download finished.
// That behaviour was defensible on paper — Patch ships ~20 times a day, so a
// prompt per download is ~20 prompts for an answer that is always yes — but in
// practice the app vanished mid-sentence and came back 75 seconds later at its
// front door. No other Squirrel app does this: Chrome, VS Code, Slack and
// Discord all download quietly and let you choose the moment.
//
// So this is Chrome's mechanism with Slack's wording. Chrome never asks and
// never interrupts; it puts a control in the corner and lets it change colour —
// quiet, then amber, then red — until you press it, which can be days. Slack
// says which version is waiting and what pressing it does. Neither ever takes
// the decision away, and neither is dismissible, because a thing you can
// dismiss is a thing you have to dismiss twenty times a day.
//
// The escalation is the whole mechanism: there is no countdown, and nothing
// here ever restarts the app on a timer. Ignoring it indefinitely is a
// supported outcome — `autoInstallOnAppQuit` means the update lands the next
// time you quit Patch anyway, so the patient path costs the user nothing.

import { useEffect, useRef, useState, type JSX } from 'react';
import { getDesktopBridge, useDesktopUpdaterState } from '../lib/desktopBridge.js';

/**
 * Mirrors `updateUrgency` in packages/desktop/src/updater.ts. Duplicated rather
 * than imported because the web bundle must not depend on the desktop package —
 * the same SPA is served to browsers and phones, which have no shell at all.
 * The thresholds are asserted against each other in the tests.
 */
const URGENCY_DUE_MS = 8 * 60 * 60 * 1000;
const URGENCY_OVERDUE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * How long a press may go unanswered. The shell's own install watchdog needs
 * two 20s stalls before it reports an error; this sits above that. An older
 * shell, a dropped IPC message or a stalled installer reports nothing at all,
 * and without this the button stayed on "Updating…" and disabled for good.
 */
const INSTALL_GRACE_MS = 60_000;

export type UpdateUrgency = 'none' | 'ready' | 'due' | 'overdue';

export function updateUrgency(staleSince: string | null, now: number): UpdateUrgency {
  if (staleSince === null) return 'none';
  const since = Date.parse(staleSince);
  // Unparseable must not read as "not stale": we know it is behind, we just
  // can't age it, so speak at the quietest volume rather than going silent.
  if (Number.isNaN(since)) return 'ready';
  const age = now - since;
  if (age >= URGENCY_OVERDUE_MS) return 'overdue';
  if (age >= URGENCY_DUE_MS) return 'due';
  return 'ready';
}

/** How long it has been waiting, in the vaguest words that are still true. */
export function waitedWords(staleSince: string, now: number): string | null {
  const age = now - Date.parse(staleSince);
  const days = Math.floor(age / (24 * 60 * 60 * 1000));
  if (days >= 1) return days === 1 ? 'since yesterday' : `for ${days} days`;
  const hours = Math.floor(age / (60 * 60 * 1000));
  if (hours >= 1) return `for ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  // Under an hour is not worth a number — it reads as pressure where there is
  // none, and this is the phase that is meant to be quiet.
  return null;
}

/**
 * The banner is driven entirely by shell state pushed over IPC. In a browser
 * there is no bridge and no shell, so it renders nothing at all — not an empty
 * strip, not a placeholder.
 */
export function DesktopUpdateBanner(): JSX.Element | null {
  const state = useDesktopUpdaterState();
  // Re-read the clock every few minutes so a shell left running overnight
  // actually escalates, rather than staying at whatever it rendered at boot.
  const [now, setNow] = useState(() => Date.now());
  // Acknowledge the press. A refused or stalled install reports through the
  // updater state's lastError; show it here, where the button was pressed.
  const [pressed, setPressed] = useState(false);
  // Only an INSTALL failure belongs next to this button; a failed background check
  // leaves the staged update exactly as installable as before.
  const lastError =
    state?.lastResult === 'error' && state.lastErrorKind === 'install' ? state.lastError : null;
  // Keyed on when the error was recorded, not its text: a second failure reads
  // identically to the first, and keying on the text left the button stuck on
  // "Updating…" with the error hidden — a press that looked like it did nothing.
  const errorAt = lastError !== null ? (state?.lastCheckedAt ?? null) : null;
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  useEffect(() => {
    if (lastError !== null) setPressed(false);
  }, [lastError, errorAt]);
  const graceTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!pressed) return;
    graceTimer.current = window.setTimeout(() => {
      setPressed(false);
      setBridgeError("Patch didn't restart. Try again, or quit and reopen it.");
    }, INSTALL_GRACE_MS);
    return () => window.clearTimeout(graceTimer.current);
  }, [pressed]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5 * 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Nothing staged means nothing to offer. `downloaded` is the honest gate:
  // an update that is merely AVAILABLE cannot be installed by pressing a
  // button, so offering Restart would be a lie until the bytes are on disk.
  if (!state || !state.downloaded || !state.availableVersion) return null;

  const urgency = updateUrgency(state.staleSince, now);
  if (urgency === 'none') return null;

  const waited = state.staleSince === null ? null : waitedWords(state.staleSince, now);
  // A failed press replaces the message and turns the banner the error colour:
  // one short sentence that says what failed and why.
  const failure =
    pressed === false
      ? (bridgeError ??
        (lastError !== null
          ? `Couldn't install Patch ${state.availableVersion}: ${lastError}`
          : null))
      : null;

  return (
    <div
      className={`desktop-update-banner ${failure === null ? urgency : 'failed'}`}
      data-testid="desktop-update-banner"
      data-urgency={urgency}
      // `status`, not `alert`: this is standing information a screen reader
      // should mention in its own time, not an interruption. It is on screen
      // for days — `alert` would make it shout on every re-render.
      role="status"
    >
      <span className="dot" aria-hidden />
      {failure === null ? (
        <span className="desktop-update-text">
          Patch has updated{waited === null ? '' : `, waiting ${waited}`}.
        </span>
      ) : (
        <span className="desktop-update-text" data-testid="desktop-update-error">
          {failure}
        </span>
      )}
      <button
        type="button"
        className="desktop-update-restart"
        data-testid="desktop-update-restart"
        data-version={state.availableVersion}
        disabled={pressed}
        onClick={() => {
          const bridge = getDesktopBridge();
          if (!bridge?.installUpdate) {
            setBridgeError("This Patch app can't install updates. Quit and reopen it.");
            return;
          }
          setBridgeError(null);
          setPressed(true);
          bridge.installUpdate();
        }}
      >
        {pressed ? 'Updating…' : 'Update Patch'}
      </button>
    </div>
  );
}
