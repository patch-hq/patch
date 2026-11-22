/**
 * The one date/time format in the app: 24-hour clock, day then month, the
 * reader's own zone. `10:16`, `17 Dec`, `17 Dec 10:16` (year added only when
 * it is not the current one).
 */
const LOCALE = 'en-GB';

/** `10:16` */
export function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString(LOCALE, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

/** `17 Dec` (`17 Dec 2025` when not this year) */
export function formatDay(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const sameYear = new Date(now).getFullYear() === d.getFullYear();
  return d.toLocaleDateString(LOCALE, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** `17 Dec 10:16` */
export function formatDateTime(at: number, now: number = Date.now()): string {
  return `${formatDay(at, now)} ${formatClock(at)}`;
}

/** The clock alone when `at` is today, otherwise the full `17 Dec 10:16`. */
export function formatWhen(at: number, now: number = Date.now()): string {
  return new Date(now).toDateString() === new Date(at).toDateString()
    ? formatClock(at)
    : formatDateTime(at, now);
}
