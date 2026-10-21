// StatusBadge — universal sidebar/header badge per spec/14 ## Status badges.
//
// ONE FOOTPRINT. Every state sits in the same 16px box (`.badge` in
// index.css): the dot states (`working`, `permission`, `done`) are a 10px
// disc, and the drawn states (`read`, `errored`, `background`, `monitoring`)
// are a glyph of matching optical weight centred in that box. The sizes below
// are tuned so a hollow circle, a disc and a line glyph read as the same
// mark in a different state, not as three different-sized things — the list
// used to draw them at 8, 9, 13, 14 and 15px and looked like it had no
// system at all.
//
// Visuals are driven by the design tokens; class names map to the `.badge`
// styling in `index.css` (lifted from design/hi-fi-tokens.css).
//
// ONE FOOTPRINT. Every state is drawn inside the same 16px box (`.badge` in
// index.css): the dot states are a 10px disc, the drawn states (read circle,
// terminal, clock, triangle) are a 12–14px glyph centred in that box. The
// sizes below are chosen so the hollow `read` circle has the same outer
// diameter as the filled dots — the list reads as one column of equal marks
// that differ by hue and shape, not by size.
//
// The variant class is NAMESPACED (`badge-permission`, not `permission`) and
// must stay that way. It used to be bare, and `index.css` also carries an
// unrelated `.permission` rule for the transcript's approval card — so the
// card's `padding: 12px; margin: 12px 0; border-radius: var(--radius)` landed
// on the 8px sidebar dot and drew a 32px blob over the row title. A bare
// `.working`/`.done`/`.read` rule would do the same to those states tomorrow.
// The `data-testid`s stay unprefixed-by-`badge-`-twice (`badge-permission`),
// which is what every test and e2e spec locates on.

import { useEffect, useState, type JSX } from 'react';
import { Circle, Clock, Terminal, TriangleAlert } from 'lucide-react';
import type { PendingWake } from '@patch/wire';
import type { DisplayBadge } from '../stores/types.js';
import { formatWakeCountdown } from './WakeBar.js';

// The state each badge colour stands for, surfaced as a tooltip so the dot
// isn't a mystery. A name only — spec/14 § Copy bans the explanatory sentence
// these four used to carry.
const BADGE_TITLE: Record<DisplayBadge, string> = {
  working: 'Working',
  permission: 'Needs your decision',
  errored: 'Failed',
  background: 'Background job running',
  monitoring: 'Monitoring',
  done: 'Done',
  read: 'Read',
};

export function StatusBadge({
  badge,
  pendingWake,
}: {
  badge: DisplayBadge;
  /** Only meaningful when `badge === 'monitoring'` — powers the hover countdown. */
  pendingWake?: PendingWake | null;
}): JSX.Element {
  const title = BADGE_TITLE[badge];
  if (badge === 'read') {
    // A grey outline circle, empty: read is the quiet resting state.
    return (
      <span className="badge badge-read" data-testid="badge-read" aria-label="read" title={title}>
        <Circle size={12} strokeWidth={2} aria-hidden />
      </span>
    );
  }
  if (badge === 'background') {
    // An idle chat that still has a background command or sub-agent running
    // (spec/14 § Status badges). A static, drawn glyph — not the tick, not a
    // tinted dot, and deliberately NOT spinning: a spin reads as the most
    // "happening right now" signal there is, which is the `working` badge's
    // job. Reusing it here for a quiet background job made the two states
    // fight for the same attention, which is the opposite of what a calm,
    // easy-to-ignore-until-it-matters status needs. Grey, like `read`, but a
    // distinct shape so it never reads as "nothing to do here". A terminal
    // glyph, not a cog: the user — "cog isn't right either, that's settings";
    // this is a command/process actually running, not configuration, and
    // not the agent reasoning (no AI/sparkle imagery) — just a mechanical
    // process turning over.
    return (
      <span
        className="badge badge-background"
        data-testid="badge-background"
        aria-label="background job running"
        title={title}
      >
        <Terminal size={13} strokeWidth={2.25} aria-hidden />
      </span>
    );
  }
  if (badge === 'monitoring') {
    // A self-wake armed (`patch_wake_me`): nothing is running right now, the
    // agent has said everything it has to say, and it will check back on its
    // own. Distinct from `background` (an actual process running) even though
    // both are grey and static.
    //
    // A plain Clock, not WakeBar's `AlarmClock` — User: "alarm is for wake, we
    // had another one that was better for monitor." The two glyphs now split
    // by what they're attached to, not by a blanket consistency rule: WakeBar
    // is the ACTIVE countdown bar (an alarm about to go off), this badge is
    // the calm at-rest sidebar signal that one is armed somewhere. The hover
    // title still mirrors WakeBar's live countdown text ("wakes in 3m") rather
    // than the static "Monitoring" label every other state gets, per the user —
    // "hover to see how long until wake".
    return <MonitoringBadge title={title} pendingWake={pendingWake} />;
  }
  if (badge === 'errored') {
    // A drawn glyph rather than a coloured dot: a failure has to be
    // distinguishable from the other states at a glance, and by SHAPE as well as
    // colour — the dots already differ only by tint, which is no use to anyone
    // reading the list quickly (or colour-blind).
    return (
      <span
        className="badge badge-errored"
        data-testid="badge-errored"
        aria-label="failed"
        title={title}
      >
        <TriangleAlert size={14} strokeWidth={2.25} aria-hidden />
      </span>
    );
  }
  return (
    <span
      className={`badge badge-${badge}`}
      data-testid={`badge-${badge}`}
      aria-label={badge}
      title={title}
    />
  );
}

/**
 * The `monitoring` badge's own tiny clock — ticks once a second, same as
 * `WakeBar`, so a tooltip left open (or reopened) never reads a stale
 * countdown. `pendingWake` is optional because some callers (BatchPanel,
 * ThreadsStrip) don't thread it through yet; those fall back to the static
 * "Monitoring" title rather than a countdown they have no data for.
 */
function MonitoringBadge({
  title,
  pendingWake,
}: {
  title: string;
  pendingWake?: PendingWake | null;
}): JSX.Element {
  const fireAt = pendingWake?.fireAt ?? null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (fireAt === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [fireAt]);

  const label = fireAt === null ? title : `Wakes ${formatWakeCountdown(fireAt - now)}`;

  return (
    <span
      className="badge badge-monitoring"
      data-testid="badge-monitoring"
      aria-label="monitoring"
      title={label}
    >
      <Clock size={13} strokeWidth={2.25} aria-hidden />
    </span>
  );
}
