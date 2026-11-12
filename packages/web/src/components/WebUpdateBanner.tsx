// WebUpdateBanner — a newer SPA bundle has been reported (a deploy shipped
// while this tab was open) and is waiting to be asked, mirroring
// DesktopUpdateBanner's contract exactly: same escalating dot (quiet → due →
// overdue), same "no dismiss, no timer — only a button" rule. See that
// component's header for why, and lib/liveUpdate.ts's header for why the SPA
// gets the same treatment now instead of reloading itself on the spot.
//
// Reuses DesktopUpdateBanner's CSS (`.desktop-update-banner` etc., including
// the overlay-titlebar rules that clear the traffic lights) rather than a
// parallel set: the two banners share the exact same top-of-shell slot and
// must look and behave like one family, not two.
//
// Inside the Mac app this banner never shows. The app is a thin shell over
// this same web page, and every release ships a new shell alongside the new
// page, so the shell's own "Restart Patch" banner covers both. Showing this one
// too meant two identically-worded prompts for one deploy: this one first
// (the server updates in seconds, the Mac build takes ~10 minutes), then the
// shell's. It only stays on when the shell cannot update itself
// (`disabledReason`, e.g. a Mac running its own local server), because then a
// reload is the only way to get the new page.

import { useEffect, useRef, useState, type JSX } from 'react';
import { useWebUpdateStore } from '../stores/webUpdateStore.js';
import { reloadNow } from '../lib/liveUpdate.js';
import {
  updateUrgency,
  waitedWords,
  UPDATE_READY_TEXT,
  UPDATE_FAILED,
} from './DesktopUpdateBanner.js';
import { useDesktopUpdaterState, useLogUpdateBanner } from '../lib/desktopBridge.js';

const RELOAD_GRACE_MS = 8_000;

export function WebUpdateBanner(): JSX.Element | null {
  const staleSince = useWebUpdateStore((s) => s.staleSince);
  // Re-read the clock every few minutes so a tab left open all day actually
  // escalates, rather than staying at whatever urgency it first rendered.
  const [now, setNow] = useState(() => Date.now());
  const desktopState = useDesktopUpdaterState();
  // A press must visibly do something. A reload that is vetoed or swallowed
  // would otherwise leave the button looking dead, so say so after a grace.
  const [pressed, setPressed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  function press(): void {
    setError(null);
    setPressed(true);
    try {
      reloadNow();
    } catch (err) {
      setPressed(false);
      setError((err as Error).message);
      return;
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setPressed(false);
      setError(UPDATE_FAILED);
    }, RELOAD_GRACE_MS);
  }

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5 * 60_000);
    return () => window.clearInterval(id);
  }, []);

  const deferred = desktopState != null && desktopState.disabledReason === null;
  const urgency = staleSince === null || deferred ? 'none' : updateUrgency(staleSince, now);
  const waited = staleSince === null ? null : waitedWords(staleSince, now);
  useLogUpdateBanner(
    'web',
    urgency === 'none' ? null : `Patch has updated${waited === null ? '' : `, waiting ${waited}`}.`,
  );
  if (staleSince === null || deferred || urgency === 'none') return null;

  return (
    <div
      className={`desktop-update-banner ${urgency}`}
      data-testid="web-update-banner"
      data-urgency={urgency}
      // `status`, not `alert` — see DesktopUpdateBanner: this is standing
      // information, not an interruption, and may be on screen for days.
      role="status"
    >
      <span className="dot" aria-hidden />
      <span className="desktop-update-text">
        {UPDATE_READY_TEXT}
        {waited === null ? '' : ` Waiting ${waited}.`}
      </span>
      {error !== null && (
        <span className="desktop-update-text" data-testid="web-update-error">
          {error}
        </span>
      )}
      <button
        type="button"
        className="desktop-update-restart"
        data-testid="web-update-reload"
        disabled={pressed}
        onClick={press}
      >
        {pressed ? 'Restarting…' : 'Restart Patch'}
      </button>
    </div>
  );
}
