// Shared snooze vocabulary (spec/04 § Snooze) — the Gmail-shaped preset list
// and wake-time formatting, factored out so the per-chat control (SnoozeMenu)
// and the whole-project control (ProjectSnoozeMenu) can never drift apart on
// what "5pm" or "next week" means. Every preset resolves itself against the
// clock at the moment of choosing into an absolute timestamp — the host
// only ever stores that, so a slow request can't drift the wake time.

import { DEFAULT_SHARED_SETTINGS, SNOOZE_UNTIL_COMPLETE, formatWakeAt } from '@patch/wire';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Today at `hour`:00 local time, pushed to tomorrow if that has already passed. */
function resolveTodayAt(hour: number): number {
  const now = new Date(Date.now());
  const at = new Date(now);
  at.setHours(hour, 0, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/** Tomorrow at `hour`:00 local time, unconditionally. */
function resolveTomorrowAt(hour: number): number {
  const at = new Date(Date.now());
  at.setDate(at.getDate() + 1);
  at.setHours(hour, 0, 0, 0);
  return at.getTime();
}

/** The coming Monday at `hour`:00 local time — a Monday today means the one a week out. */
function resolveNextMondayAt(hour: number): number {
  const at = new Date(Date.now());
  at.setDate(at.getDate() + ((8 - at.getDay()) % 7 || 7));
  at.setHours(hour, 0, 0, 0);
  return at.getTime();
}

export interface SnoozePreset {
  id: string;
  label: string;
  resolve: () => number;
}

/** The hours the wall-clock presets wake at — the account's snooze defaults (Settings → Chats). */
export interface SnoozeHours {
  morningHour: number;
  eveningHour: number;
}

export const DEFAULT_SNOOZE_HOURS: SnoozeHours = {
  morningHour: DEFAULT_SHARED_SETTINGS.snoozeMorningHour,
  eveningHour: DEFAULT_SHARED_SETTINGS.snoozeEveningHour,
};

/** `9` → "9am", `17` → "5pm". */
export function hourLabel(hour: number): string {
  return `${hour % 12 || 12}${hour < 12 ? 'am' : 'pm'}`;
}

/** The Gmail-shaped presets, in menu order, with the wall-clock ones at the given hours. */
export function snoozePresets({ morningHour, eveningHour }: SnoozeHours): SnoozePreset[] {
  return [
    { id: '30-minutes', label: '30 minutes', resolve: () => Date.now() + 30 * MINUTE },
    { id: '1-hour', label: '1 hour', resolve: () => Date.now() + HOUR },
    { id: 'evening', label: hourLabel(eveningHour), resolve: () => resolveTodayAt(eveningHour) },
    {
      id: 'tomorrow-morning',
      label: `Tomorrow ${hourLabel(morningHour)}`,
      resolve: () => resolveTomorrowAt(morningHour),
    },
    { id: '1-day', label: '1 day', resolve: () => Date.now() + DAY },
    {
      id: 'next-monday',
      label: 'Next Monday',
      resolve: () => resolveNextMondayAt(morningHour),
    },
  ];
}

/** The presets at the default hours (spec/14 § Chat panel header). */
export const SNOOZE_PRESETS: ReadonlyArray<SnoozePreset> = snoozePresets(DEFAULT_SNOOZE_HOURS);

/** Presets closer than this to an earlier one say the same thing (Next Monday on a Sunday is Tomorrow morning). */
const SAME_MOMENT = 15 * MINUTE;

/** The presets worth showing right now: any that resolves to within 15 minutes of an earlier one is dropped. */
export function distinctPresets(presets: ReadonlyArray<SnoozePreset>): SnoozePreset[] {
  const kept: Array<{ preset: SnoozePreset; at: number }> = [];
  for (const preset of presets) {
    const at = preset.resolve();
    if (kept.every((k) => Math.abs(k.at - at) >= SAME_MOMENT)) kept.push({ preset, at });
  }
  return kept.map((k) => k.preset);
}

/** "Until complete": wakes when the chat's work is done, not at a time. Offered only for a chat with work to wait for. */
export const UNTIL_COMPLETE_PRESET: SnoozePreset = {
  id: 'until-complete',
  label: 'Until complete',
  resolve: () => SNOOZE_UNTIL_COMPLETE,
};

/**
 * A wake time wherever a surface names one outside the sheet — the sidebar's
 * Snoozed rows, the banner on an open snoozed chat, the header tooltip. The
 * same wording as the sheet (spec/04 § Snooze): `HH:MM` today, `Fri 08:00`
 * within six days, `Thu 22 Oct` beyond, always 24-hour; "when done" for a
 * snooze until complete.
 */
export function formatWakeTime(at: number): string {
  return formatWakeAt(at);
}

export { formatWakeAt, formatSnoozeMoment, formatElapsed } from '@patch/wire';
