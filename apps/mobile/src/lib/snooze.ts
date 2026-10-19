// Snooze primitives (spec/04 § Snooze) — shared by the row-actions sheet, the
// Snoozed section and the chat-detail banner.
//
// Most presets are a DELTA (e.g. "5 minutes"); two ("5pm", "Tomorrow 8am")
// are wall-clock targets. Both kinds resolve here, against the clock at the
// moment of choosing, to the SAME absolute timestamp the host stores: a
// delta sent as-is would drift by however long the request spends in flight,
// so "5 minutes" would mean something different at each end.
//
// Custom is typed as `YYYY-MM-DD HH:mm` (parseCustomSnooze) — no native date
// picker, which would need a new APK (spec/15 § Row tools).

import { SNOOZE_UNTIL_COMPLETE } from '@patch/wire';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface SnoozePreset {
  id: string;
  label: string;
  resolve: () => number;
}

// Same "today at hour unless past, else tomorrow" / "tomorrow at hour,
// unconditionally" logic as packages/web/src/components/SnoozeMenu.tsx —
// duplicated rather than shared because web and mobile are separate
// packages with no existing shared util for this.
function resolveTodayAt(hour: number): number {
  const now = new Date(Date.now());
  const at = new Date(now);
  at.setHours(hour, 0, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.getTime();
}

function resolveTomorrowAt(hour: number): number {
  const at = new Date(Date.now());
  at.setDate(at.getDate() + 1);
  at.setHours(hour, 0, 0, 0);
  return at.getTime();
}

/** The coming Monday at 8am local time — a Monday today means the one a week out. */
function resolveNextMondayAt(hour: number): number {
  const at = new Date(Date.now());
  at.setDate(at.getDate() + ((8 - at.getDay()) % 7 || 7));
  at.setHours(hour, 0, 0, 0);
  return at.getTime();
}

export const SNOOZE_PRESETS: readonly SnoozePreset[] = [
  { id: '2-minutes', label: '2 minutes', resolve: () => Date.now() + 2 * MINUTE },
  { id: '5-minutes', label: '5 minutes', resolve: () => Date.now() + 5 * MINUTE },
  { id: '30-minutes', label: '30 minutes', resolve: () => Date.now() + 30 * MINUTE },
  { id: '1-hour', label: '1 hour', resolve: () => Date.now() + HOUR },
  { id: '5pm', label: '5pm', resolve: () => resolveTodayAt(17) },
  { id: 'tomorrow-8am', label: 'Tomorrow 8am', resolve: () => resolveTomorrowAt(8) },
  { id: '1-day', label: '1 day', resolve: () => Date.now() + DAY },
  { id: 'next-monday', label: 'Next Monday', resolve: () => resolveNextMondayAt(8) },
];

/** "Until complete": wakes when the chat's work is done, not at a time. Offered only for a chat with work to wait for. */
export const UNTIL_COMPLETE_PRESET: SnoozePreset = {
  id: 'until-complete',
  label: 'Until complete',
  resolve: () => SNOOZE_UNTIL_COMPLETE,
};

/** Parses a typed local `YYYY-MM-DD HH:mm`; throws on malformed or past input (no fallback). */
export function parseCustomSnooze(text: string, now: number = Date.now()): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) throw new Error('snooze: enter a date and time as YYYY-MM-DD HH:mm');
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const at = new Date(y, mo - 1, d, h, mi, 0, 0);
  if (at.getMonth() !== mo - 1 || at.getDate() !== d || h > 23 || mi > 59) {
    throw new Error('snooze: that date or time does not exist');
  }
  if (at.getTime() <= now) throw new Error('snooze: pick a time in the future');
  return at.getTime();
}

/** Resolves a preset to the absolute ms-epoch `snoozedUntil` the host stores. */
export function resolvePreset(preset: SnoozePreset): number {
  return preset.resolve();
}

/** Wake time as a short local date+time, e.g. `09:30` today, `Tue 09:30` beyond. */
export function formatWakeTime(at: number): string {
  if (at === SNOOZE_UNTIL_COMPLETE) return 'when done';
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const sameDay = new Date().toDateString() === d.toDateString();
  if (sameDay) return time;
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

/**
 * Wake time sized for a row's right-hand timestamp slot: `14:00` today, `Tue`
 * within the coming week, `30 Sep` beyond — a bare weekday a week out would
 * name today.
 */
export function formatWakeTimeCompact(at: number): string {
  const d = new Date(at);
  const now = new Date();
  if (now.toDateString() === d.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (at - startOfToday.getTime() < 7 * DAY) {
    return d.toLocaleDateString(undefined, { weekday: 'short' });
  }
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
