// Snooze again after answering (spec/04 § Snooze → Resnooze after an answer).
//
// A snooze can end because the chat stopped for the person (a question, a
// permission). Answering it should not cost them the quiet they asked for, so
// the question card offers "Send answer and snooze". The new wake time is the
// old snooze's own length again, counted from now; an until-complete snooze is
// until-complete again.

import { isSnoozeUntilComplete } from '@patch/wire';
import type { ChatRow } from '../stores/types.js';

/** The wake time to snooze to after the answer, or null when the chat has no such snooze to repeat. */
export function resnoozeTarget(row: ChatRow | undefined, now: number): number | null {
  if (!row) return null;
  if (row.snoozedUntil !== null && row.snoozedUntil > now) return null;
  const last = row.snoozeRecords?.[row.snoozeRecords.length - 1];
  if (!last || last.endedAt === null || last.outcome.kind !== 'waiting') return null;
  if (isSnoozeUntilComplete(last.until)) return last.until;
  const span = last.until - last.startedAt;
  return span > 0 ? now + span : null;
}
