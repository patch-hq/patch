// Starts/Stops widget support (spec/08 § Filter, spec/14 § Jobs view).
//
// A job's `filter` is one JSONata string, evaluated against `{ payload, now }`
// on every trigger type (spec/08 § Filter). A date-bounded condition —
// "every Friday, starting 1 May 2027" — is just `now >= "2027-05-01..."` in
// that language: no bespoke start-date field, no cron/recurrence-only special
// case. This module is the two-way bridge between that raw text and the
// plain-date-picker UI a human actually wants to look at and edit, using
// `react-querybuilder`'s own JSONata parser/formatter for the "heavy lifting"
// — walking the real parse tree — rather than a hand-rolled regex over
// arbitrary JSONata text.
//
// Deliberately narrow: this recognises exactly the shape it itself produces
// (a top-level `and` of `now` comparisons and plain rules, plus the bracketed
// group it writes for a remainder that ORs) and falls back to treating the
// ENTIRE filter as opaque custom text otherwise — an OR at the top, a `now`
// inside a nested group, or a `now` comparison with an operator it doesn't
// understand (`=`, `!=`, ...) all count as "can't represent this as a date
// range," not "partially represent it and silently drop the rest."

import { formatQuery, isRuleGroup, type RuleGroupType, type RuleType } from 'react-querybuilder';
import { parseJSONata } from 'react-querybuilder/parseJSONata';

export interface ParsedDateRangeFilter {
  /** ISO 8601, or null if the filter sets no lower bound. */
  start: string | null;
  /** ISO 8601, or null if the filter sets no upper bound. */
  stop: string | null;
  /**
   * Everything else in the filter — the custom-JSONata textarea's content.
   * Null when there is nothing left over (the filter was ONLY a date range,
   * or empty to begin with).
   */
  remainder: string | null;
}

const NOTHING_RECOGNISED = (filter: string): ParsedDateRangeFilter => ({
  start: null,
  stop: null,
  remainder: filter,
});

/**
 * Split a stored `filter` into its date-range part and everything else.
 * Real JSONata parsing throughout — a filter this can't confidently pick
 * apart comes back as pure `remainder`, never a guessed partial start/stop.
 */
export function parseDateRangeFromFilter(filter: string | null): ParsedDateRangeFilter {
  if (filter === null || filter.trim() === '') return { start: null, stop: null, remainder: null };

  let tree: RuleGroupType;
  try {
    tree = parseJSONata(filter) as RuleGroupType;
  } catch {
    // Not valid JSONata at all (or a shape parseJSONata's grammar rejects) —
    // leave it as opaque text for the raw editor rather than erroring here;
    // the server's own validate.ts is the place a truly broken filter is
    // refused (spec/08 § Filter).
    return NOTHING_RECOGNISED(filter);
  }

  if (tree.combinator !== 'and' || tree.rules.length === 0) return NOTHING_RECOGNISED(filter);

  let start: string | null = null;
  let stop: string | null = null;
  const rest: (RuleType | RuleGroupType)[] = [];

  for (const rule of tree.rules) {
    if (isRuleGroup(rule)) {
      // A bracketed group is remainder (build writes one for an OR), but a
      // `now` inside it is not a date range this widget can show.
      if (mentionsNow(rule)) return NOTHING_RECOGNISED(filter);
      rest.push(rule);
      continue;
    }
    if (rule.field !== 'now') {
      rest.push(rule);
      continue;
    }
    if (rule.operator === 'between' && Array.isArray(rule.value)) {
      const [lo, hi] = rule.value as [unknown, unknown];
      start = lo === undefined ? null : String(lo);
      stop = hi === undefined ? null : String(hi);
    } else if (rule.operator === '>=' && typeof rule.value === 'string') {
      start = rule.value;
    } else if (rule.operator === '<=' && typeof rule.value === 'string') {
      stop = rule.value;
    } else {
      // A `now` comparison this widget doesn't speak (`now = "..."`, an
      // OR'd `now`, …) — don't half-show it; the whole filter goes back as
      // custom text so nothing is silently dropped.
      return NOTHING_RECOGNISED(filter);
    }
  }

  if (start === null && stop === null) return NOTHING_RECOGNISED(filter);

  // A lone group is formatted on its own so its brackets don't pile up on
  // each build/parse cycle.
  const lone = rest.length === 1 ? rest[0]! : null;
  const remainder =
    rest.length === 0
      ? null
      : formatQuery(lone && isRuleGroup(lone) ? lone : { combinator: 'and', rules: rest }, {
          format: 'jsonata',
        });
  return { start, stop, remainder };
}

function mentionsNow(group: RuleGroupType): boolean {
  return group.rules.some((r) => (isRuleGroup(r) ? mentionsNow(r) : r.field === 'now'));
}

/**
 * The inverse of `parseDateRangeFromFilter`: build the stored `filter` string
 * from a start date, a stop date, and whatever custom JSONata the raw editor
 * carries. Any of the three may be absent; returns null (no filter at all)
 * only when all three are.
 */
export function buildFilterFromDateRange(
  start: string | null,
  stop: string | null,
  remainder: string | null,
): string | null {
  const rules: RuleType[] = [];
  if (start) rules.push({ field: 'now', operator: '>=', value: start });
  if (stop) rules.push({ field: 'now', operator: '<=', value: stop });
  const dateClause =
    rules.length > 0 ? formatQuery({ combinator: 'and', rules }, { format: 'jsonata' }) : null;

  const trimmedRemainder = remainder && remainder.trim() !== '' ? remainder.trim() : null;

  // `and` binds tighter than `or`: an unparenthesised `a or b` would let the
  // `b` branch fire outside the date range.
  if (dateClause && trimmedRemainder) {
    const rest = /\bor\b/i.test(trimmedRemainder) ? `(${trimmedRemainder})` : trimmedRemainder;
    return `${dateClause} and ${rest}`;
  }
  return dateClause ?? trimmedRemainder;
}

/**
 * ISO 8601 → a `<input type="datetime-local">` value, in the browser's own
 * zone — that input has no zone concept of its own, so what the user sees and
 * edits is local wall-clock time, matching every other date the app shows.
 * Null/unparseable → `''` (no date set).
 */
export function isoToLocalInputValue(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The inverse of `isoToLocalInputValue`: a `datetime-local` value (local
 * time, no zone) → ISO 8601 UTC. Empty/unparseable → null.
 */
export function localInputValueToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
