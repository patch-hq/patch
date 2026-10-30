// English → cron for the New-job schedule field, ported from
// packages/web/src/lib/naturalCron.ts. Mobile can't import from the web
// package (it's not a dependency) and this PARSER is not in @patch/wire, so
// the two copies must be kept in sync. Pure logic — no RN.
//
// The other direction — cron → English, `describeCron` — used to be ported
// here too, which is what made the two copies drift apart from the Jobs
// list's own third implementation. It now lives in @patch/wire, which mobile
// already depends on, and is re-exported below so every call site here is
// unchanged. Do NOT re-port it: the whole point is that one describer speaks
// for every surface.
//
// NO FALLBACK to a wrong guess: `parseNaturalSchedule` returns null when it
// can't confidently parse, and the form keeps the raw cron field authoritative.

export { describeCron } from '@patch/wire';

const DOW_NAME: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

/** Parse a clock time like `9am`, `9:30am`, `7.30pm`, `17:00`, `noon`, `midnight`, `9`. */
function parseTime(raw: string): { h: number; m: number } | null {
  const t = raw.trim().toLowerCase();
  if (t === 'noon') return { h: 12, m: 0 };
  if (t === 'midnight') return { h: 0, m: 0 };
  const m = t.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = parseInt(m[1]!, 10);
  const min = m[2] ? parseInt(m[2]!, 10) : 0;
  const ap = m[3];
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

/**
 * A time-of-day window: "between 9am and 5pm", "from 9 to 17", "9am-5pm".
 * Returns the start/end HOURS (cron hour ranges are hour-granular), null when
 * there is no window, or 'invalid' when there is one cron can't express.
 * The end hour is inclusive — "between 9am and 5pm" → hours 9-17.
 */
const TIME_TOKEN = '(\\d{1,2}(?:[:.]\\d{2})?\\s*(?:am|pm)?|noon|midnight)';
function parseTimeWindow(text: string): { startH: number; endH: number } | 'invalid' | null {
  const re = new RegExp(
    `\\b(?:between|from)\\s+${TIME_TOKEN}\\s+(?:and|to|until|–|—|-)\\s+${TIME_TOKEN}`,
  );
  // The compact form needs am/pm on both ends so a bare "9-5" is not guessed at.
  const compact = new RegExp(
    '\\b(\\d{1,2}(?:[:.]\\d{2})?\\s*(?:am|pm))\\s*(?:–|—|-)\\s*(\\d{1,2}(?:[:.]\\d{2})?\\s*(?:am|pm))\\b',
  );
  const m = text.match(re) ?? text.match(compact);
  if (!m) return null;
  const start = parseTime(m[1]!);
  const end = parseTime(m[2]!);
  if (!start || !end) return 'invalid';
  if (start.h > end.h) return 'invalid'; // a window that wraps midnight isn't a simple cron range
  // The hour field is all cron has: a window opening or closing between hours
  // would fire before it opens and after it closes.
  if (start.m !== 0 || end.m !== 0) return 'invalid';
  return { startH: start.h, endH: end.h };
}

/** Every unambiguous clock time in a phrase: am/pm, a colon or dot, noon, midnight. */
const CLOCK_TOKEN =
  /\b\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)\b|\b\d{1,2}[:.]\d{2}\b|\bnoon\b|\bmidnight\b/g;

const DAY_ALT = Object.keys(DOW_NAME)
  .sort((a, b) => b.length - a.length)
  .join('|');
const DAY_RANGE = new RegExp(
  `\\b(${DAY_ALT})s?\\s*(?:to|through|thru|until|–|—|-)\\s*(${DAY_ALT})s?\\b`,
);

/** Day-of-week field from a phrase fragment, or '*' for every day. */
function parseDow(text: string): string | null {
  // A range of named days ("monday to friday", "mon-fri"), which may wrap the week.
  const range = text.match(DAY_RANGE);
  if (range) {
    const lo = DOW_NAME[range[1]!]!;
    const hi = DOW_NAME[range[2]!]!;
    if (lo === hi) return String(lo);
    if (lo < hi) return `${lo}-${hi}`;
    // Ending the day before it starts is the whole week.
    if ((hi + 1) % 7 === lo) return '*';
    const days: number[] = [];
    for (let d = lo; d % 7 !== (hi + 1) % 7; d++) days.push(d % 7);
    return days.sort((a, b) => a - b).join(',');
  }
  if (/\bweekdays?\b/.test(text) || /\bevery weekday\b/.test(text)) return '1-5';
  if (/\bweekends?\b/.test(text)) return '0,6';
  if (/\b(every ?day|daily|day)\b/.test(text)) return '*';
  // Explicit day names, possibly a list ("monday and thursday", "mon, wed").
  const found: number[] = [];
  for (const [name, n] of Object.entries(DOW_NAME)) {
    if (new RegExp(`\\b${name}s?\\b`).test(text) && !found.includes(n)) found.push(n);
  }
  if (found.length > 0) return found.sort((a, b) => a - b).join(',');
  return null;
}

/**
 * Best-effort English → 5-field cron. Returns null when it can't parse with
 * confidence. Supported shapes:
 *   - "every 15 minutes" / "every minute"
 *   - "every 2 hours" / "hourly" / "every hour"
 *   - "every day at 9am" / "daily at 09:00" / "at 9am" / "8am every day"
 *   - "every day at 9am and 10pm" / "at 9am, 1pm and 10pm" (shared minute only)
 *   - "every weekday at 9am" / "weekdays at 8:30"
 *   - "every weekend at 10am"
 *   - "every monday at 8:30" / "mondays at 8" / "monday and thursday at 9am"
 */
export function parseNaturalSchedule(input: string): string | null {
  const text = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (text === '') return null;

  // A cadence this cannot express (every 2 days, weekly, monthly) must not
  // collapse into a daily schedule: refuse it rather than guess.
  if (
    /\b(?:weeks?|months?|years?|weekly|monthly|yearly|annually|fortnightly|fortnight|biweekly|quarterly)\b/.test(
      text,
    ) ||
    /\bevery (?:other|second|alternate|\d+) (?:days?|weekdays?|weekends?)\b/.test(text)
  ) {
    return null;
  }

  // A one-off ("once at 9am tomorrow", "next friday", "on the 5th") is not a
  // repeating schedule. Reading only its clock time turned it into a daily
  // cron, so refuse the whole phrase.
  if (
    /\b(?:once|one[- ]?off|one time|tomorrow|today|tonight|yesterday|next|this|\d{1,2}(?:st|nd|rd|th)|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/.test(
      text,
    )
  ) {
    return null;
  }

  // A word that changes the meaning of everything around it and that cron
  // cannot express ("except friday", "9am or 10pm"): refuse the whole phrase.
  // Reading past it produced the OPPOSITE schedule — "every hour between 9am
  // and 5pm except weekends" came out as `0 9-17 * * 0,6`.
  if (/\b(?:except|excluding|but not|or)\b/.test(text)) return null;

  // An optional time-of-day window ("between 9am and 5pm") and day-of-week
  // ("on weekdays") constrain the interval forms below. The hour field is the
  // window range (or `*`); the day field is the parsed days (or `*`).
  // A window that is there but can't be expressed must not widen to all day.
  const window = parseTimeWindow(text);
  if (window === 'invalid') return null;
  const hourField = window ? `${window.startH}-${window.endH}` : '*';
  const dowField = parseDow(text) ?? '*';

  // Interval: every N minutes (optionally within a window / on given days).
  const everyMin = text.match(/^every (\d+) ?(?:minutes?|mins?|m)\b/);
  if (everyMin) {
    const n = parseInt(everyMin[1]!, 10);
    if (n >= 1 && n <= 59) return `*/${n} ${hourField} * * ${dowField}`;
  }
  if (/^every minute\b/.test(text)) return `* ${hourField} * * ${dowField}`;

  // Interval: every N hours / hourly (optionally within a window). A windowed
  // hourly step uses cron's range-step form, e.g. `9-17/2`.
  const everyHour = text.match(/^every (\d+) ?(?:hours?|hrs?|h)\b/);
  if (everyHour) {
    const n = parseInt(everyHour[1]!, 10);
    if (n >= 1 && n <= 23) {
      const hf = window ? `${hourField}/${n}` : `*/${n}`;
      return `0 ${hf} * * ${dowField}`;
    }
  }
  if (/^(?:hourly|every hour)\b/.test(text)) return `0 ${hourField} * * ${dowField}`;

  // A window only bounds an interval; with none, its end time is not "the" time.
  if (window) return null;

  // Time-of-day forms. Pull an explicit "at <time>" (or a list of them —
  // "at 9am and 10pm", "at 9am, 1pm and 10pm") first; else a trailing time.
  // Cron's minute and hour fields are independent, so a list can only be
  // expressed when every time shares one minute; otherwise → null, never a guess.
  let times: { h: number; m: number }[] = [];
  const atMatch = text.match(
    new RegExp(`\\bat (${TIME_TOKEN}(?:\\s*(?:,|&|\\band\\b)\\s*${TIME_TOKEN})*)(?![0-9:]|\\.\\d)`),
  );
  if (atMatch) {
    const parts = atMatch[1]!.split(/\s*(?:,|&|\band\b)\s*/).filter((p) => p !== '');
    const parsed = parts.map(parseTime);
    if (parsed.some((t) => t === null)) return null;
    times = parsed as { h: number; m: number }[];
    if (times.some((t) => t.m !== times[0]!.m)) return null;
  }
  if (times.length === 0) {
    // A leading time ("8am every day", "17:30 weekdays"): a bare number is
    // too ambiguous here, so it needs am/pm, a colon or dot, or noon/midnight.
    const lead = text.match(
      /^(\d{1,2}[:.]\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm)|noon|midnight)(?=\s|$)/,
    );
    const t = lead ? parseTime(lead[1]!) : null;
    if (t) times = [t];
  }
  if (times.length === 0) {
    const tail = text.match(/(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)|noon|midnight)\s*$/);
    const t = tail ? parseTime(tail[1]!) : null;
    if (t) times = [t];
  }
  // Every clock time in the phrase must have been read into `times`. A second
  // time outside the "at" list ("at 9am and at 5pm", "8am and 5pm every day")
  // is not expressible as one cron, and a cron carrying only the first would
  // be a guess dressed up as a parse.
  const clockTokens = text.match(CLOCK_TOKEN)?.length ?? 0;
  const atCount = text.match(/\bat\b/g)?.length ?? 0;
  if (clockTokens > times.length || atCount > 1) return null;
  const time =
    times.length > 0
      ? { m: times[0]!.m, h: [...new Set(times.map((t) => t.h))].sort((a, b) => a - b).join(',') }
      : null;

  const dow = parseDow(text);

  // A day-of-week phrase (weekday/weekend/named day/daily) → run at the given
  // time, defaulting to midnight only when no time-like text was supplied at
  // all. Digits that failed to parse as a time ("9 every day") → null, never
  // a silent midnight.
  if (dow !== null) {
    if (!time && /\d/.test(text)) return null;
    const t = time ?? { h: '0', m: 0 };
    return `${t.m} ${t.h} * * ${dow}`;
  }
  // Just a time, no day phrase → every day at that time.
  if (time && (atMatch || /\b(every day|daily)\b/.test(text) || /^at /.test(text))) {
    return `${time.m} ${time.h} * * *`;
  }
  return null;
}
