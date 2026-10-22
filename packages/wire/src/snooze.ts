// Snooze records (spec/04 § Snooze): what a snooze was and what happened in
// it. One record per snooze, per chat, kept in meta.json and carried on
// `chat.state` so every surface agrees on the Back state and the transcript
// divider. The functions here are pure: the host, the server and the surfaces
// all derive from the same ones.

import { z } from 'zod';

export const SnoozeOutcomeKind = z.enum(['finished', 'waiting', 'errored', 'running', 'none']);
export type SnoozeOutcomeKind = z.infer<typeof SnoozeOutcomeKind>;

export const SnoozeOutcome = z
  .object({
    kind: SnoozeOutcomeKind,
    /** ms epoch the outcome happened (finished/errored) or began (waiting). Absent for running/none. */
    at: z.number().int().optional(),
  })
  .strict();
export type SnoozeOutcome = z.infer<typeof SnoozeOutcome>;

export const SnoozeRecord = z
  .object({
    /** The chats snoozed by one action share a set id; a single-chat snooze is a set of one. */
    setId: z.string().min(1),
    startedAt: z.number().int(),
    /** Highest log seq at snooze start — the transcript divider sits after it. */
    startSeq: z.number().int(),
    /** The scheduled wake time (moves if the chat is re-snoozed while snoozed). */
    until: z.number().int(),
    /** When the snooze ended (lapsed or ended early); `null` while still snoozed. */
    endedAt: z.number().int().nullable(),
    /** Tracked while snoozed, final once `endedAt` is set. */
    outcome: SnoozeOutcome,
    /** Tracking for `outcome`: last turn finish, last error, when it began waiting on a person. */
    finishedAt: z.number().int().optional(),
    erroredAt: z.number().int().optional(),
    waitingSince: z.number().int().optional(),
    /** The Back state has been dismissed for this set; the divider stays. */
    backCleared: z.boolean(),
  })
  .strict();
export type SnoozeRecord = z.infer<typeof SnoozeRecord>;

/**
 * `snoozedUntil` for "Until complete" (spec/04 § Snooze): the largest time a JS
 * Date can hold, so "snoozed ⇔ snoozedUntil > now" stays true everywhere with no
 * second field. The host ends it when the chat's work completes, not at a time.
 */
export const SNOOZE_UNTIL_COMPLETE = 8_640_000_000_000_000;

export function isSnoozeUntilComplete(until: number | null | undefined): boolean {
  return until === SNOOZE_UNTIL_COMPLETE;
}

/** How many records a chat keeps. */
export const MAX_SNOOZE_RECORDS = 20;

/** The state `deriveSnoozeOutcome` reads. */
export interface SnoozeOutcomeInput {
  activity: 'idle' | 'running' | 'awaiting-permission' | 'errored';
  /** A declared `patch_ask_human` question is outstanding. */
  askingQuestion: boolean;
  finishedAt?: number | undefined;
  erroredAt?: number | undefined;
  waitingSince?: number | undefined;
  /** Used when the chat is waiting/errored but no moment was tracked. */
  now: number;
}

/** What happened in a snooze, from the chat's state when it ended. */
export function deriveSnoozeOutcome(i: SnoozeOutcomeInput): SnoozeOutcome {
  if (i.activity === 'awaiting-permission' || i.askingQuestion) {
    return { kind: 'waiting', at: i.waitingSince ?? i.now };
  }
  if (i.activity === 'errored') return { kind: 'errored', at: i.erroredAt ?? i.now };
  if (i.activity === 'running') return { kind: 'running' };
  if (i.finishedAt !== undefined) return { kind: 'finished', at: i.finishedAt };
  return { kind: 'none' };
}

/** The record for the snooze a chat is in right now, if any. */
export function openSnoozeRecord(
  records: readonly SnoozeRecord[] | undefined,
): SnoozeRecord | null {
  const last = records?.[records.length - 1];
  return last && last.endedAt === null ? last : null;
}

/** The Back state a chat is showing (ended, not yet cleared), if any. */
export function backRecord(records: readonly SnoozeRecord[] | undefined): SnoozeRecord | null {
  const last = records?.[records.length - 1];
  return last && last.endedAt !== null && !last.backCleared ? last : null;
}

/**
 * The chats whose Back state clears when `chatId` is interacted with: every chat
 * showing Back for the same set. Empty when `chatId` has no Back state.
 */
export function backSetToClear(
  chats: ReadonlyArray<{ chatId: string; snoozeRecords?: readonly SnoozeRecord[] | undefined }>,
  chatId: string,
): string[] {
  const mine = backRecord(chats.find((c) => c.chatId === chatId)?.snoozeRecords);
  if (!mine) return [];
  return chats
    .filter((c) => backRecord(c.snoozeRecords)?.setId === mine.setId)
    .map((c) => c.chatId);
}

/** `45m`, `12h`, `3d` — how long a snooze lasted. */
export function formatSnoozeDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
