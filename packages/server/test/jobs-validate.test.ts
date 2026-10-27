// Unit coverage for jobs/validate.ts — the single semantic gate shared by
// every CRUD surface (REST, RPC bridge, file load). Exercises every branch:
// cron field-count / node-cron validity, and job `filter` JSONata, both valid
// and invalid, plus the "nothing to validate" pass-through paths.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import {
  assertRecurrenceCanFire,
  assertValidJobBody,
  JobValidationError,
} from '../src/jobs/validate.js';
import { JobStore } from '../src/jobs/store.js';
import type { JobCreateBody } from '../src/jobs/types.js';

function baseBody(overrides: Partial<JobCreateBody> = {}): JobCreateBody {
  return {
    name: 'test',
    trigger: { type: 'cron', expression: '0 9 * * *' },
    action: { type: 'spawn', hostId: 'd1', folder: '/work', prompt: 'go' },
    ...overrides,
  };
}

describe('assertValidJobBody', () => {
  it('accepts a valid 5-field cron expression', () => {
    expect(() => assertValidJobBody(baseBody())).not.toThrow();
  });

  it.each(['0 8 31 2 *', '0 8 30 2 *', '0 8 31 4 *'])(
    'rejects cron %s whose day/month can never occur',
    (expression) => {
      try {
        assertValidJobBody(
          baseBody({ trigger: { type: 'cron', expression, timezone: 'Europe/London' } }),
        );
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(JobValidationError);
        expect((err as JobValidationError).field).toBe('trigger.expression');
      }
    },
  );

  it.each(['0 8 29 2 *', '0 8 * * 1'])('accepts cron %s that does fire', (expression) => {
    expect(() =>
      assertValidJobBody(
        baseBody({ trigger: { type: 'cron', expression, timezone: 'Europe/London' } }),
      ),
    ).not.toThrow();
  });

  it('rejects a cron expression that is not exactly 5 fields', () => {
    expect(() =>
      assertValidJobBody(baseBody({ trigger: { type: 'cron', expression: '0 0 9 * * *' } })),
    ).toThrow(JobValidationError);
    try {
      assertValidJobBody(baseBody({ trigger: { type: 'cron', expression: '* * * * * *' } }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(JobValidationError);
      expect((err as JobValidationError).field).toBe('trigger.expression');
      expect((err as JobValidationError).message).toContain('expected 5 fields');
    }
  });

  it('rejects a 5-field cron expression that node-cron considers invalid', () => {
    try {
      assertValidJobBody(baseBody({ trigger: { type: 'cron', expression: '99 99 99 99 99' } }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(JobValidationError);
      expect((err as JobValidationError).field).toBe('trigger.expression');
      expect((err as JobValidationError).message).toContain('invalid cron expression');
      expect((err as JobValidationError).message).not.toContain('expected 5 fields');
    }
  });

  // node-cron expands a step of zero by walking a range that never advances.
  // `cron.validate('*/0 * * * *')` burns ~5 SECONDS of blocking CPU before
  // answering false — on the single-threaded Fastify event loop, so for those
  // five seconds the server answers nothing at all: no surface, no webhook, no
  // host frame. Job writes come from the REST route, the host UDS, direct
  // file loads AND the in-chat `patch_job_create` bridge, so an agent inventing
  // `*/0` freezes the box. The cheap structural check has to run first.
  it('refuses a zero-step cron without handing it to node-cron to chew on', () => {
    const started = Date.now();
    try {
      assertValidJobBody(baseBody({ trigger: { type: 'cron', expression: '*/0 * * * *' } }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(JobValidationError);
      expect((err as JobValidationError).field).toBe('trigger.expression');
      expect((err as JobValidationError).message).toContain('invalid cron expression');
    }
    // The structural check is microseconds. Anything near node-cron's ~5s means
    // the expression reached it.
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('refuses a zero step spelled `a/0`, which node-cron calls VALID', () => {
    // `cron.validate('1/0 * * * *')` returns true, so this one was persisted and
    // then registered with the live scheduler — a stored schedule that cannot
    // mean anything.
    try {
      assertValidJobBody(baseBody({ trigger: { type: 'cron', expression: '1/0 * * * *' } }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(JobValidationError);
      expect((err as JobValidationError).field).toBe('trigger.expression');
      expect((err as JobValidationError).message).toContain('invalid cron expression');
    }
  });

  it('still accepts every cron expression the live jobs actually use', () => {
    // Tightening the gate must not orphan a stored job: validate.ts also runs on
    // FILE LOAD, so a newly-refused expression stops an existing job dead.
    for (const expression of [
      '0 9 * * *',
      '0 9 * * 5',
      '17 7,11,15,19 * * *',
      '0 */4 * * *',
      '0,30 7-22 * * *',
      '0 9-22 * * *',
      '*/5 * * * *',
      '15 8 * * 1',
    ]) {
      expect(() =>
        assertValidJobBody(baseBody({ trigger: { type: 'cron', expression } })),
      ).not.toThrow();
    }
  });

  it('accepts a valid recurrence trigger', () => {
    expect(() =>
      assertValidJobBody(
        baseBody({
          trigger: {
            type: 'recurrence',
            rrule: 'FREQ=MONTHLY;BYDAY=SU;BYSETPOS=3;BYMONTH=5,6,7,8;BYHOUR=9;BYMINUTE=0',
            timezone: 'Europe/London',
          },
        }),
      ),
    ).not.toThrow();
  });

  it('rejects a recurrence trigger whose rrule does not parse', () => {
    try {
      assertValidJobBody(
        baseBody({
          trigger: { type: 'recurrence', rrule: 'FREQ=BOGUS', timezone: 'Europe/London' },
        }),
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(JobValidationError);
      expect((err as JobValidationError).field).toBe('trigger.rrule');
      expect((err as JobValidationError).message).toContain('invalid RRULE');
    }
  });

  it('rejects a recurrence trigger whose rrule is unparseable garbage', () => {
    try {
      assertValidJobBody(
        baseBody({
          trigger: {
            type: 'recurrence',
            rrule: 'this is not an rrule at all',
            timezone: 'Europe/London',
          },
        }),
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(JobValidationError);
      expect((err as JobValidationError).field).toBe('trigger.rrule');
    }
  });

  it('rejects a recurrence rule with no FREQ (rrule would default it to yearly)', () => {
    try {
      assertValidJobBody(
        baseBody({ trigger: { type: 'recurrence', rrule: 'BYHOUR=9', timezone: 'Europe/London' } }),
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(JobValidationError);
      expect((err as JobValidationError).field).toBe('trigger.rrule');
      expect((err as JobValidationError).message).toContain('FREQ');
    }
  });

  it.each([
    'FREQ=DAILY;BYHOUR=9;BYMINUTE=75',
    'FREQ=DAILY;BYHOUR=25;BYMINUTE=0',
    'FREQ=DAILY;BYHOUR=9,24;BYMINUTE=0',
    'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=60',
    'FREQ=YEARLY;BYMONTH=13;BYHOUR=9',
    'FREQ=MONTHLY;BYMONTHDAY=0;BYHOUR=9',
    'FREQ=MONTHLY;BYMONTHDAY=32;BYHOUR=9',
    'FREQ=MONTHLY;BYMONTHDAY=-32;BYHOUR=9',
    'FREQ=MONTHLY;BYDAY=SU;BYSETPOS=0;BYHOUR=9',
    'FREQ=MONTHLY;BYDAY=SU;BYSETPOS=367;BYHOUR=9',
    'FREQ=DAILY;INTERVAL=-1;BYHOUR=9;BYMINUTE=0',
    'FREQ=DAILY;INTERVAL=0;BYHOUR=9;BYMINUTE=0',
  ])('rejects a recurrence rule with an out-of-range field: %s', (rrule) => {
    try {
      assertValidJobBody(baseBody({ trigger: { type: 'recurrence', rrule, timezone: 'UTC' } }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(JobValidationError);
      expect((err as JobValidationError).field).toBe('trigger.rrule');
    }
  });

  it('accepts recurrence fields at the edges of their ranges', () => {
    for (const rrule of [
      'FREQ=DAILY;BYHOUR=0,23;BYMINUTE=0,59;BYSECOND=0,59',
      'FREQ=YEARLY;BYMONTH=1,12;BYMONTHDAY=1,31,-1,-31;BYHOUR=9',
      'FREQ=MONTHLY;BYDAY=SU;BYSETPOS=-1;BYHOUR=9',
    ]) {
      expect(() =>
        assertValidJobBody(baseBody({ trigger: { type: 'recurrence', rrule, timezone: 'UTC' } })),
      ).not.toThrow();
    }
  });

  it('accepts a valid job-level filter', () => {
    expect(() =>
      assertValidJobBody(baseBody({ filter: 'payload.action = "closed"' })),
    ).not.toThrow();
  });

  it('accepts a null/empty/absent filter without validating it', () => {
    expect(() => assertValidJobBody(baseBody({ filter: null }))).not.toThrow();
    expect(() => assertValidJobBody(baseBody({ filter: '' }))).not.toThrow();
    expect(() => assertValidJobBody(baseBody())).not.toThrow();
  });

  it('rejects an invalid job-level JSONata filter', () => {
    try {
      assertValidJobBody(baseBody({ filter: '$.broken(' }));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(JobValidationError);
      expect((err as JobValidationError).field).toBe('filter');
      expect((err as JobValidationError).message).toContain('invalid JSONata (filter)');
    }
  });

  it('a JobValidationError carries name "JobValidationError"', () => {
    try {
      assertValidJobBody(baseBody({ filter: '$.broken(' }));
      throw new Error('expected throw');
    } catch (err) {
      expect((err as Error).name).toBe('JobValidationError');
    }
  });

  it('webhook and todoist triggers (no cron semantics) pass through untouched', () => {
    expect(() =>
      assertValidJobBody(baseBody({ trigger: { type: 'webhook', scheme: 'none' } })),
    ).not.toThrow();
    expect(() => assertValidJobBody(baseBody({ trigger: { type: 'todoist' } }))).not.toThrow();
  });

  it('a patch body with no trigger at all skips trigger validation entirely', () => {
    expect(() => assertValidJobBody({ name: 'renamed' })).not.toThrow();
  });
});

describe('assertRecurrenceCanFire', () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const recurrence = (rrule: string) => ({
    type: 'recurrence' as const,
    rrule,
    timezone: 'Europe/London',
  });

  it('accepts an unbounded rule and an UNTIL still in the future', () => {
    expect(() =>
      assertRecurrenceCanFire(recurrence('FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0'), now),
    ).not.toThrow();
    expect(() =>
      assertRecurrenceCanFire(
        recurrence('FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0;UNTIL=20270101T000000Z'),
        now,
      ),
    ).not.toThrow();
  });

  it.each([
    // Every rule is enumerated from a fixed 2000-01-01 anchor, so a COUNT is
    // spent in 2000 — it can never fire now.
    'FREQ=DAILY;COUNT=3',
    'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0;UNTIL=20200201T000000Z',
  ])('refuses a rule with no future occurrence: %s', (rrule) => {
    try {
      assertRecurrenceCanFire(recurrence(rrule), now);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(JobValidationError);
      expect((err as JobValidationError).field).toBe('trigger.rrule');
      expect((err as JobValidationError).message).toContain('never fire');
    }
  });

  it('ignores non-recurrence and absent triggers', () => {
    expect(() =>
      assertRecurrenceCanFire({ type: 'cron', expression: '0 9 * * *' }, now),
    ).not.toThrow();
    expect(() => assertRecurrenceCanFire(undefined, now)).not.toThrow();
  });
});

describe('JobStore refuses a recurrence rule that can never fire', () => {
  const silentLogger = pino({ level: 'silent' });
  const expired = {
    type: 'recurrence' as const,
    rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0;UNTIL=20200201T000000Z',
    timezone: 'Europe/London',
  };
  const action = { type: 'spawn' as const, hostId: 'd1', folder: '/work', prompt: 'go' };
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('on create, and on a patch that sets one', () => {
    dir = mkdtempSync(join(tmpdir(), 'patch-validate-'));
    const store = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    expect(() => store.create({ name: 'x', trigger: expired, action })).toThrow(JobValidationError);
    const job = store.create({
      name: 'x',
      trigger: { ...expired, rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0' },
      action,
    });
    expect(() => store.patch(job.id, { trigger: expired })).toThrow(JobValidationError);
  });

  it('still loads and edits a stored job whose rule has since run out', () => {
    dir = mkdtempSync(join(tmpdir(), 'patch-validate-'));
    mkdirSync(join(dir, 'jobs'));
    const id = 'j_01J00000000000000000000000';
    writeFileSync(
      join(dir, 'jobs', `${id}.json`),
      JSON.stringify({
        id,
        name: 'ran out',
        enabled: true,
        trigger: expired,
        filter: null,
        action,
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    const store = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
    expect(store.get(id)?.trigger).toEqual(expired);
    // The editor re-sends the unchanged trigger with every save.
    expect(store.patch(id, { name: 'renamed', trigger: expired }).name).toBe('renamed');
    expect(store.patch(id, { enabled: false }).enabled).toBe(false);
  });
});
