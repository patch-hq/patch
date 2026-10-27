// Semantic validation for job bodies — the SINGLE source of truth shared by
// every CRUD surface (REST `/api/jobs`, the host UDS `/internal/jobs`, the
// cross-chat `patch_job_*` RPC bridge, and direct file edits loaded by the
// store). Zod proves the SHAPE; this proves the SEMANTICS:
//
//   - cron trigger    → the expression is a valid 5-field cron (node-cron).
//   - job filter      → the `filter` JSONata compiles.
//
// Per spec/08 (jobs are a "single source of truth") and the portfolio-wide
// NO-FALLBACKS rule: a bad-cron / bad-JSONata job must be REJECTED at write
// time on every surface, never silently persisted to produce no runs. The
// validation lives in `JobStore.create`/`patch` (the one canonical write
// point) so the two CRUD surfaces can never diverge.

import { Cron } from 'croner';
import cron from 'node-cron';
import jsonata from 'jsonata';
import rrulePkg from 'rrule';
import { assertValidCron, isValidTimeZone } from '@patch/wire';
import { nextOccurrence } from './recurrence.js';
import type { JobCreateBody, JobPatchBody, JobTrigger, Queueing } from './types.js';

const { RRule } = rrulePkg;

/** RRULE fields `rrule` accepts at any value, with their RFC 5545 ranges. */
const RRULE_RANGES = [
  ['byhour', 'BYHOUR', 0, 23],
  ['byminute', 'BYMINUTE', 0, 59],
  ['bysecond', 'BYSECOND', 0, 59],
  ['bymonth', 'BYMONTH', 1, 12],
  // ±1..31, never 0 — a negative day counts back from the month's end.
  ['bymonthday', 'BYMONTHDAY', -31, 31],
] as const;

export class JobValidationError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = 'JobValidationError';
  }
}

/**
 * Cross-field rules for a job's queueing (spec/08 § Queueing), checked on the
 * job AS IT WILL BE STORED so a patch that changes only the action is still
 * held to them. NO FALLBACK: a combination that cannot mean one thing is
 * refused rather than resolved in favour of either field.
 */
export function assertValidQueueing(job: {
  queueing?: Queueing | null;
  concurrency?: number | null;
  action: { type: string };
}): void {
  const q = job.queueing;
  if (q === undefined || q === null) return;
  if (job.concurrency !== undefined && job.concurrency !== null) {
    throw new JobValidationError(
      '`queueing` and `concurrency` both set the job limit — use queueing { mode: "queue", concurrency } and drop `concurrency`',
      'queueing',
    );
  }
  if (q.mode === 'append' && job.action.type !== 'continue') {
    throw new JobValidationError(
      `queueing mode "append" delivers into one durable chat, which only a "continue" action has (this action is "${job.action.type}")`,
      'queueing.mode',
    );
  }
}

/**
 * Refuse a recurrence rule with no occurrence after `now`. The scheduler
 * enumerates every rule from a fixed 2000-01-01 anchor, so a COUNT is spent
 * in 2000 and a past UNTIL is already over — either would save looking
 * healthy and then never fire. Separate from `assertValidJobBody` because it
 * depends on the clock: the store runs it on create, and on a patch only when
 * the trigger CHANGES, so a stored rule that has since run out can still be
 * loaded, renamed or disabled.
 */
export function assertRecurrenceCanFire(trigger: JobTrigger | undefined, now: Date): void {
  if (!trigger || trigger.type !== 'recurrence') return;
  if (nextOccurrence(trigger.rrule, trigger.timezone, now) === null) {
    throw new JobValidationError(
      `RRULE has no future occurrences — it would never fire: ${trigger.rrule}`,
      'trigger.rrule',
    );
  }
}

/**
 * Validate the semantic content of a create/patch body. Throws
 * `JobValidationError` on the first problem (NO FALLBACK). Callers map this to
 * a 400 (REST) / `invalid_input` (RPC bridge) / process-level skip (file load).
 */
export function assertValidJobBody(body: JobCreateBody | JobPatchBody): void {
  const trigger = body.trigger;
  if (trigger && trigger.type === 'cron') {
    // Spec/08 mandates a STANDARD 5-field cron. node-cron.validate() also
    // accepts 6/7-field expressions (with a leading seconds/year field), but
    // those silently mis-schedule under our 5-field assumption — node-cron
    // would treat field 1 as seconds. Reject anything that isn't exactly 5
    // fields BEFORE the validate() check (NO FALLBACK).
    const fieldCount = trigger.expression.trim().split(/\s+/).length;
    if (fieldCount !== 5) {
      throw new JobValidationError(
        `invalid cron expression (expected 5 fields, got ${fieldCount}): ${trigger.expression}`,
        'trigger.expression',
      );
    }
    // STRUCTURE FIRST, and not only for tidiness. node-cron expands a step of
    // zero by walking a range that never advances: `cron.validate('*/0 * * * *')`
    // burns SECONDS of blocking CPU before answering false (~5s idle, ~19s on a
    // loaded box). That happens on the single-threaded event loop, so the server
    // answers nothing at all meanwhile — no surface, no webhook, no host
    // frame — and a job write is reachable from the REST route, the host UDS,
    // a file load and the in-chat `patch_job_create` bridge alike, so an agent
    // that invents `*/0` freezes the box for everyone.
    //
    // It also catches what node-cron gets WRONG: `1/0` is a zero step too, and
    // `cron.validate` calls it valid, so it was persisted and registered as a
    // schedule that cannot mean anything.
    //
    // @patch/wire's checker is the pure-TS mirror of this grammar (cron-tz.ts) —
    // linear in the expression's length, no expansion — so it is safe to run on
    // anything. node-cron still runs after it, as the authority on what it will
    // actually accept at registration time.
    try {
      assertValidCron(trigger.expression);
    } catch (err) {
      throw new JobValidationError((err as Error).message, 'trigger.expression');
    }
    if (!cron.validate(trigger.expression)) {
      throw new JobValidationError(
        `invalid cron expression: ${trigger.expression}`,
        'trigger.expression',
      );
    }
    // The zone is what node-cron evaluates the expression in. A zone this
    // machine's ICU cannot resolve makes node-cron throw at REGISTRATION
    // time — after the job is already persisted and looking healthy — so
    // refuse it at write time instead. NO FALLBACK: never demote to UTC.
    if (trigger.timezone !== undefined && !isValidTimeZone(trigger.timezone)) {
      throw new JobValidationError(
        `invalid IANA timezone: ${trigger.timezone}`,
        'trigger.timezone',
      );
    }
    // A day/month pair that never occurs (31 Feb, 31 Apr) passes every check
    // above, persists, registers, and never fires. Ask the live scheduler's
    // own engine (same options as cron.ts) whether it has a next run.
    const probe = new Cron(trigger.expression, {
      timezone: trigger.timezone ?? 'UTC',
      domAndDow: true,
      paused: true,
    });
    const next = probe.nextRun();
    probe.stop();
    if (next === null) {
      throw new JobValidationError(
        `cron expression has no future occurrences, it would never fire: ${trigger.expression}`,
        'trigger.expression',
      );
    }
  }
  if (trigger && trigger.type === 'recurrence') {
    // `timezone` is validated at the schema layer (RecurrenceTrigger.timezone
    // is IanaTimeZone, required, not optional — see @patch/wire/jobs) so
    // there's nothing left to check for it here. The one thing zod's plain
    // `z.string().min(1)` cannot catch is whether `rrule` PARSES — the same
    // role `cron.validate()` plays for a cron expression. `RRule.fromString`
    // parses the bare RRULE value string (no `RRULE:`/`DTSTART`) exactly as
    // the scheduler will (`packages/server/src/jobs/recurrence.ts`), so a rule
    // rejected here is refused at write time rather than persisted looking
    // healthy and then silently refused at registration (NO FALLBACK).
    let opts: ReturnType<typeof RRule.parseString>;
    try {
      opts = RRule.parseString(trigger.rrule);
      RRule.fromString(trigger.rrule);
    } catch (err) {
      throw new JobValidationError(`invalid RRULE: ${(err as Error).message}`, 'trigger.rrule');
    }
    // `rrule` range-checks only BYSETPOS. Everything else it takes on trust:
    // BYMINUTE=75 rolls over to the next hour, BYHOUR=25 to the next day, and
    // a rule with no FREQ silently becomes YEARLY — each one saves looking
    // healthy and fires at a time nobody wrote. Refuse them the way node-cron
    // refuses an out-of-range cron field (NO FALLBACK).
    if (opts.freq === undefined) {
      throw new JobValidationError(
        `invalid RRULE (FREQ is required): ${trigger.rrule}`,
        'trigger.rrule',
      );
    }
    // INTERVAL below 1 is not a repeat at all: a negative one sends
    // `rule.after()` into a loop that never returns, freezing the server.
    if (opts.interval !== undefined && opts.interval !== null && opts.interval < 1) {
      throw new JobValidationError(
        `invalid RRULE (INTERVAL=${opts.interval} is out of range): ${trigger.rrule}`,
        'trigger.rrule',
      );
    }
    for (const [key, field, min, max] of RRULE_RANGES) {
      const raw = opts[key] as number | number[] | null | undefined;
      if (raw === undefined || raw === null) continue;
      for (const n of Array.isArray(raw) ? raw : [raw]) {
        const ok = key === 'bymonthday' ? n !== 0 && Math.abs(n) <= max : n >= min && n <= max;
        if (!ok) {
          throw new JobValidationError(
            `invalid RRULE (${field}=${n} is out of range): ${trigger.rrule}`,
            'trigger.rrule',
          );
        }
      }
    }
  }
  if (typeof body.filter === 'string' && body.filter.length > 0) {
    try {
      jsonata(body.filter);
    } catch (err) {
      throw new JobValidationError(`invalid JSONata (filter): ${(err as Error).message}`, 'filter');
    }
  }
}
