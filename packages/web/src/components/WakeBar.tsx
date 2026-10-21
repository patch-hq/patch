// WakeBar — shows the chat's pending self-wake above the transcript
// (patch/todo.md — "cron should be visible in a bar above the chat, showing how
// long until next wakeup and the prompt"; spec/02 § Self-wake, spec/14 § Main
// chat panel).
//
// The "cron" the user means is `patch_wake_me` / `patch_loop`: patch disallows
// Claude Code's CronCreate (it cannot fire in the host's SDK model) and owns
// the timer itself. A pending wake is a scheduled FUTURE TURN in this chat, so
// it must never be invisible — this bar is the readout: a live countdown to
// `fireAt` plus the message the wake will deliver.
//
// Every wake carries a dismiss (×) and an edit (pencil → roomy modal). Both go
// through the same `chat.loop_request`/`patch_cancel_wake` path whichever
// surface armed it; editing re-arms, replacing the pending wake.

import { useEffect, useState, type JSX } from 'react';
import { AlarmClock, Pencil, X } from 'lucide-react';
import { api } from '../api/rest.js';
import { useUiStore } from '../stores/uiStore.js';
import type { ChatRow } from '../stores/types.js';
import { failed } from '../lib/errorCopy.js';
import { creditPause } from '../lib/queueLabel.js';
import { formatReset } from '../lib/usage.js';
import { WakeEditModal } from './WakeEditModal.js';

/**
 * Humanise the wait until `fireAt`. Coarse-to-fine so the bar reads naturally at
 * any horizon: `3h 4m`, `9m`, `2m 5s`, `45s`. Seconds are shown only under an
 * hour (a 3-hour countdown ticking seconds is noise), and a wake whose time has
 * passed but whose turn hasn't landed yet reads `now` rather than a negative or
 * a stale number — the host delivers it imminently (or on the next boot).
 */
export function formatWakeCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return 'now';
  const totalSec = Math.ceil(msRemaining / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `in ${h}h ${m}m`;
  if (m > 0 && s > 0) return `in ${m}m ${s}s`;
  if (m > 0) return `in ${m}m`;
  return `in ${s}s`;
}

/**
 * Humanise a recurring interval for the "loops every …" label: `5m`, `1h 30m`,
 * `45s`. Unlike `formatWakeCountdown` this has no "now"/"in" framing — it
 * names a fixed cadence, not a countdown — and always shows the coarsest two
 * units rather than dropping seconds only under an hour, since an interval
 * (unlike a one-off wait) is worth reading precisely at any size.
 */
export function formatEvery(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

export function WakeBar({ row }: { row: ChatRow }): JSX.Element | null {
  const wake = row.pendingWake;
  const fireAt = wake?.fireAt ?? null;
  const [now, setNow] = useState(() => Date.now());
  const pushError = useUiStore((s) => s.pushError);
  const [editing, setEditing] = useState(false);

  // Tick every second so the countdown is live. Only while a wake is armed —
  // no timer runs for the (overwhelmingly common) chat with nothing pending.
  useEffect(() => {
    if (fireAt === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [fireAt]);

  if (!wake) return null;

  const countdown = formatWakeCountdown(wake.fireAt - now);
  const isLoop = wake.every !== undefined;
  const waiting = wake.waiting === true;
  // A wake is a turn; with the chat out of credit it cannot run, so the bar
  // warns instead of promising a time it cannot keep.
  const pause = creditPause(row);
  const pauseNote =
    pause === null
      ? ''
      : pause.resetsAt === null
        ? ' · out of credit'
        : ` · out of credit until ${formatReset(pause.resetsAt, now)}`;

  function dismiss(): void {
    void api.setLoop(row.chatId, null).catch((err) => {
      pushError(
        failed(isLoop ? 'stopping loop' : 'dismissing wake'),
        undefined,
        (err as Error).message,
      );
    });
  }

  return (
    <div
      className={pause ? 'wake-bar wake-bar-warn' : 'wake-bar'}
      data-testid="wake-bar"
      data-paused={pause ? 'true' : undefined}
      role="status"
    >
      <span className="wake-bar-label">
        <AlarmClock size={14} aria-hidden />
        <span className="wake-bar-countdown" data-testid="wake-bar-countdown">
          {isLoop
            ? waiting
              ? `Loops every ${formatEvery(wake.every!)} · waiting for current turn${pauseNote}`
              : `Loops every ${formatEvery(wake.every!)} · next ${countdown}${pauseNote}`
            : `Wakes ${countdown}${pauseNote}`}
        </span>
      </span>
      <span className="wake-bar-message" data-testid="wake-bar-message" title={wake.message}>
        {wake.message}
      </span>
      <button
        type="button"
        className="wake-bar-stop-btn"
        data-testid="wake-bar-edit-btn"
        aria-label="Edit wake"
        title="Edit wake"
        onClick={() => setEditing(true)}
      >
        <Pencil size={14} aria-hidden />
      </button>
      <button
        type="button"
        className="wake-bar-stop-btn"
        data-testid="wake-bar-stop-btn"
        aria-label={isLoop ? 'Stop loop' : 'Dismiss wake'}
        title={isLoop ? 'Stop loop' : 'Dismiss wake'}
        onClick={dismiss}
      >
        <X size={14} aria-hidden />
      </button>
      {editing && (
        <WakeEditModal chatId={row.chatId} wake={wake} onClose={() => setEditing(false)} />
      )}
    </div>
  );
}
