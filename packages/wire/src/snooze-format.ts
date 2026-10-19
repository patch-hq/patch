// Wake-time and Back-state wording for snoozes (spec/04 § Snooze, spec/14 §
// Snooze sheet), shared by the web and Android surfaces so they say the same
// thing. Pure: all times are local to the device formatting them.

import {
  backRecord,
  isSnoozeUntilComplete,
  formatSnoozeDuration,
  type SnoozeOutcome,
  type SnoozeRecord,
} from './snooze.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function clockOf(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * A wake time as the snooze sheet, toast and sidebar show it: `HH:MM` if it is
 * today, `Fri 08:00` within the next 6 days, `Thu 22 Oct` beyond that
 * (spec/14 § Snooze sheet). Always 24-hour, whatever the locale.
 */
export function formatWakeAt(at: number, now: number = Date.now()): string {
  if (isSnoozeUntilComplete(at)) return 'when done';
  const d = new Date(at);
  const days = Math.round((startOfDay(d) - startOfDay(new Date(now))) / DAY);
  if (days === 0) return clockOf(d);
  if (days > 0 && days <= 6) return `${DAY_NAMES[d.getDay()]!} ${clockOf(d)}`;
  return `${DAY_NAMES[d.getDay()]!} ${d.getDate()} ${MONTH_NAMES[d.getMonth()]!}`;
}

/** A moment of a past snooze for the transcript divider: a weekday goes before a time not on `ref`'s day. */
export function formatSnoozeMoment(at: number, ref: number): string {
  const d = new Date(at);
  const sameDay = startOfDay(d) === startOfDay(new Date(ref));
  return sameDay ? clockOf(d) : `${DAY_NAMES[d.getDay()]!} ${clockOf(d)}`;
}

/** `25m`, `2h 10m` — how long a run has gone on. */
export function formatElapsed(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE));
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export type OutcomeTone = 'ok' | 'ask' | 'error' | 'running';

/**
 * What the chat did while snoozed, as the second line of a returned row:
 * "finished 03:52", "waiting on you since 21:14", "error at 23:05",
 * "still running". `none` has no line. `at` formats a moment (default HH:MM).
 */
export function outcomeLine(
  outcome: SnoozeOutcome,
  at: (ms: number) => string = clock,
): { text: string; tone: OutcomeTone } | null {
  const when = outcome.at === undefined ? '' : at(outcome.at);
  switch (outcome.kind) {
    case 'finished':
      return { text: `finished ${when}`, tone: 'ok' };
    case 'waiting':
      return { text: `waiting on you since ${when}`, tone: 'ask' };
    case 'errored':
      return { text: `error at ${when}`, tone: 'error' };
    case 'running':
      return { text: 'still running', tone: 'running' };
    case 'none':
      return null;
  }
}

/**
 * The folder header pill: "back · snoozed 12h" for the most recent set that is
 * back in the folder, or `null` when none is.
 */
export function folderBackPill(
  rows: ReadonlyArray<{ snoozeRecords?: readonly SnoozeRecord[] | undefined }>,
): string | null {
  let latest: SnoozeRecord | null = null;
  for (const r of rows) {
    const rec = backRecord(r.snoozeRecords);
    if (rec && (latest === null || (rec.endedAt ?? 0) > (latest.endedAt ?? 0))) latest = rec;
  }
  if (!latest || latest.endedAt === null) return null;
  return `back · snoozed ${formatSnoozeDuration(latest.endedAt - latest.startedAt)}`;
}

/**
 * The permanent divider in the transcript where a snooze began:
 * "Snoozed 19:42 – 08:00 · finished 03:52". A weekday goes before any time
 * that is not on the wake day.
 */
export function snoozeDividerText(record: SnoozeRecord): string {
  if (record.endedAt === null && isSnoozeUntilComplete(record.until)) {
    return `Snoozed ${clock(record.startedAt)} – until complete`;
  }
  const end = record.endedAt ?? record.until;
  const range = `Snoozed ${formatSnoozeMoment(record.startedAt, end)} – ${clock(end)}`;
  const line =
    record.endedAt === null
      ? null
      : outcomeLine(record.outcome, (ms) => formatSnoozeMoment(ms, end));
  return line ? `${range} · ${line.text}` : range;
}

/** The returned-row state of a chat — its record and the line it shows — or `null` when it is not showing Back. */
export function rowBack(row: { snoozeRecords?: readonly SnoozeRecord[] | undefined }): {
  record: SnoozeRecord;
  line: { text: string; tone: OutcomeTone } | null;
} | null {
  const record = backRecord(row.snoozeRecords);
  if (!record) return null;
  return { record, line: outcomeLine(record.outcome) };
}
