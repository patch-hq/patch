// spec/04 § Reminders — `/remind [every <n> <unit>] <text>`. One parser for every
// surface so web and phone read the same words the same way.

import type { ReminderEvery } from './events.js';

export interface ParsedReminderArg {
  reminder: string | null;
  every: ReminderEvery | null;
}

const EVERY = /^every\s+(\d+)\s*(turns?|t|minutes?|mins?|m|hours?|hrs?|h)\b\s*([\s\S]*)$/i;

/**
 * Parse the text after `/remind`. `every 10 turns Keep to the principles` →
 * repeated every 10 agent turns; `every 30m …` / `every 2 hours …` → timed
 * (hours become minutes). Without the `every` prefix it is a plain banner
 * reminder. An empty rest is a clear. A cadence with no text is rejected
 * rather than guessed at.
 */
export function parseReminderArg(rest: string | null): ParsedReminderArg {
  const text = (rest ?? '').trim();
  if (text === '') return { reminder: null, every: null };
  const m = EVERY.exec(text);
  if (!m) return { reminder: text, every: null };
  const count = Number(m[1]);
  const unitWord = m[2]!.toLowerCase();
  const body = (m[3] ?? '').trim();
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('reminder frequency must be at least 1');
  }
  if (body === '')
    throw new Error('a repeating reminder needs text: /remind every 10 turns <text>');
  const isTurns = unitWord.startsWith('t');
  const isHours = unitWord.startsWith('h');
  const n = isHours ? count * 60 : count;
  if (n > 10000) throw new Error('reminder frequency is too large');
  return { reminder: body, every: { unit: isTurns ? 'turns' : 'minutes', n } };
}

/** Short label for a banner: "every 10 turns", "every 30 min". */
export function describeReminderEvery(every: ReminderEvery): string {
  return every.unit === 'turns'
    ? `every ${every.n} ${every.n === 1 ? 'turn' : 'turns'}`
    : every.n % 60 === 0
      ? `every ${every.n / 60} h`
      : `every ${every.n} min`;
}
