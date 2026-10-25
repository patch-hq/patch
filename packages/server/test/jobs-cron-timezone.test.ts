// spec/08 § Cron: the expression is stored exactly as authored and evaluated
// in `trigger.timezone` (absent → UTC).
//
// This file is the regression proof for the reported bug: "9am jobs fire at
// 10am during BST". The scheduler used to hardcode `{ timezone: 'UTC' }`, so
// `0 9 * * *` meant 09:00 UTC = 10:00 London wall-clock every summer. The DST
// block below drives the REAL scheduler and asserts the fire instant moves with
// the zone: 08:00 UTC in summer, 09:00 UTC in winter — the same 9am to a
// person in London, which is the whole point.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { JobStore } from '../src/jobs/store.js';
import { JobDispatcher } from '../src/jobs/dispatcher.js';
import { JobLogs } from '../src/jobs/logs.js';
import { CronScheduler, croner, type CronTask, type ScheduleFn } from '../src/jobs/cron.js';
import { assertValidJobBody, JobValidationError } from '../src/jobs/validate.js';
import { InProcessHostLink } from '../src/host-link.js';
import type { JobCreateBody, JobPatchBody } from '../src/jobs/types.js';

const silentLogger = pino({ level: 'silent' });

// 2026 UK DST: BST runs 29 Mar → 25 Oct. These two instants sit safely either
// side, so the offset difference is unambiguous.
const SUMMER = '2026-07-15T12:00:00Z'; // Europe/London = UTC+1
const WINTER = '2026-01-15T12:00:00Z'; // Europe/London = UTC+0

// A spawn action names its host and carries exactly one first turn — a body
// missing the prompt is refused for THAT reason, which would mask the
// timezone assertions on the REST route.
const ACTION = { type: 'spawn', hostId: 'd1', folder: '/work', prompt: 'go' } as const;

/** Wire up the store/dispatcher/logs a CronScheduler needs. */
function makeDeps(dir: string): { jobs: JobStore; dispatcher: JobDispatcher; logs: JobLogs } {
  const jobs = new JobStore({ dataDir: dir, logger: silentLogger, watch: false });
  const logs = new JobLogs(dir);
  const dispatcher = new JobDispatcher({
    dataDir: dir,
    hostLink: new InProcessHostLink(),
    logger: silentLogger,
    logs: new JobLogs(dir),
  });
  return { jobs, dispatcher, logs };
}

describe('cron timezone reaches the scheduler', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-crontz-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("hands node-cron the job's own zone", () => {
    const { jobs, dispatcher, logs } = makeDeps(dir);
    const seen: Array<{ expr: string; timezone: string | undefined }> = [];
    const scheduler = new CronScheduler({
      jobs,
      dispatcher,
      logs,
      logger: silentLogger,
      schedule: ((expr: string, _cb: unknown, opts: { timezone?: string }) => {
        seen.push({ expr, timezone: opts.timezone });
        return { stop: () => undefined } as unknown as CronTask;
      }) as unknown as ScheduleFn,
    });
    scheduler.start();
    jobs.create({
      name: 'daily email update',
      trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' },
      action: ACTION,
    });
    expect(seen).toEqual([{ expr: '0 9 * * *', timezone: 'Europe/London' }]);
    scheduler.stop();
  });

  it('stores the expression EXACTLY as authored — no rewrite into UTC', () => {
    const { jobs, dispatcher, logs } = makeDeps(dir);
    const scheduler = new CronScheduler({
      jobs,
      dispatcher,
      logs,
      logger: silentLogger,
      schedule: (() =>
        ({
          stop: () => undefined,
          nextRun: () => new Date(),
        }) as unknown as CronTask) as unknown as ScheduleFn,
    });
    scheduler.start();
    const job = jobs.create({
      name: 'daily email update',
      trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' },
      action: ACTION,
    });
    const stored = jobs.get(job.id)!;
    expect(stored.trigger).toEqual({
      type: 'cron',
      expression: '0 9 * * *',
      timezone: 'Europe/London',
    });
    scheduler.stop();
  });

  it("falls back to UTC ONLY when the job carries no zone — a pre-timezone job's instant is unchanged", () => {
    const { jobs, dispatcher, logs } = makeDeps(dir);
    const seen: Array<string | undefined> = [];
    const scheduler = new CronScheduler({
      jobs,
      dispatcher,
      logs,
      logger: silentLogger,
      schedule: ((_e: string, _cb: unknown, opts: { timezone?: string }) => {
        seen.push(opts.timezone);
        return { stop: () => undefined } as unknown as CronTask;
      }) as unknown as ScheduleFn,
    });
    scheduler.start();
    jobs.create({
      name: 'legacy',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      action: ACTION,
    });
    expect(seen).toEqual(['UTC']);
    scheduler.stop();
  });

  it('re-registers with the NEW zone when the trigger is patched', () => {
    const { jobs, dispatcher, logs } = makeDeps(dir);
    const seen: Array<string | undefined> = [];
    const scheduler = new CronScheduler({
      jobs,
      dispatcher,
      logs,
      logger: silentLogger,
      schedule: ((_e: string, _cb: unknown, opts: { timezone?: string }) => {
        seen.push(opts.timezone);
        return { stop: () => undefined } as unknown as CronTask;
      }) as unknown as ScheduleFn,
    });
    scheduler.start();
    const job = jobs.create({
      name: 'daily',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      action: ACTION,
    });
    jobs.patch(job.id, {
      trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'America/New_York' },
    });
    expect(seen).toEqual(['UTC', 'America/New_York']);
    scheduler.stop();
  });

  it('surfaces the zone on the registration log line so a mis-zoned job is diagnosable', () => {
    const { jobs, dispatcher, logs } = makeDeps(dir);
    const lines: Array<Record<string, unknown>> = [];
    const capturing = {
      info: (obj: Record<string, unknown>, msg: string) => lines.push({ ...obj, msg }),
      error: () => undefined,
      warn: () => undefined,
      debug: () => undefined,
    } as unknown as pino.Logger;
    const scheduler = new CronScheduler({
      jobs,
      dispatcher,
      logs,
      logger: capturing,
      schedule: (() =>
        ({
          stop: () => undefined,
          nextRun: () => new Date(),
        }) as unknown as CronTask) as unknown as ScheduleFn,
    });
    scheduler.start();
    jobs.create({
      name: 'daily',
      trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' },
      action: ACTION,
    });
    const registered = lines.find((l) => l['msg'] === 'jobs/cron: registered');
    expect(registered?.['timezone']).toBe('Europe/London');
    scheduler.stop();
  });

  it('logs an error when a registered task has no future occurrence', () => {
    const { jobs, dispatcher, logs } = makeDeps(dir);
    const errors: string[] = [];
    const capturing = {
      info: () => undefined,
      error: (_o: unknown, msg: string) => errors.push(msg),
      warn: () => undefined,
      debug: () => undefined,
    } as unknown as pino.Logger;
    const scheduler = new CronScheduler({
      jobs,
      dispatcher,
      logs,
      logger: capturing,
      schedule: (() =>
        ({
          stop: () => undefined,
          nextRun: () => null,
        }) as unknown as CronTask) as unknown as ScheduleFn,
    });
    scheduler.start();
    jobs.create({
      name: 'daily',
      trigger: { type: 'cron', expression: '0 9 * * *' },
      action: ACTION,
    });
    expect(errors).toContain(
      'jobs/cron: registered but has no future occurrence, it will never fire',
    );
    scheduler.stop();
  });
});

// The zone is only useful if an unresolvable one is refused BEFORE the job is
// persisted — node-cron throws at registration time otherwise, leaving a job
// on disk that looks healthy and never runs. NO FALLBACK: never demote to UTC.
describe('an unresolvable zone is rejected at write time', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-crontz-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('assertValidJobBody names trigger.timezone on a create body', () => {
    const body = {
      name: 'daily',
      trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/Landon' },
      action: ACTION,
    } as unknown as JobCreateBody;
    expect(() => assertValidJobBody(body)).toThrowError(/invalid IANA timezone: Europe\/Landon/);
    try {
      assertValidJobBody(body);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(JobValidationError);
      expect((err as JobValidationError).field).toBe('trigger.timezone');
    }
  });

  it('assertValidJobBody rejects a bare UTC offset — frozen, so it cannot track DST', () => {
    const body = {
      trigger: { type: 'cron', expression: '0 9 * * *', timezone: '+01:00' },
    } as unknown as JobPatchBody;
    expect(() => assertValidJobBody(body)).toThrowError(/invalid IANA timezone/);
  });

  it('assertValidJobBody accepts a real zone and an absent one', () => {
    expect(() =>
      assertValidJobBody({
        trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' },
      } as unknown as JobPatchBody),
    ).not.toThrow();
    expect(() =>
      assertValidJobBody({
        trigger: { type: 'cron', expression: '0 9 * * *' },
      } as unknown as JobPatchBody),
    ).not.toThrow();
  });

  it('JobStore.create refuses the job, and nothing is persisted', () => {
    const { jobs } = makeDeps(dir);
    expect(() =>
      jobs.create({
        name: 'bad zone',
        trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Mars/Olympus' },
        action: ACTION,
      } as unknown as JobCreateBody),
    ).toThrowError(/invalid IANA timezone/);
    expect(jobs.list()).toHaveLength(0);
  });

  it('JobStore.patch refuses the change and leaves the good zone in place', () => {
    const { jobs } = makeDeps(dir);
    const job = jobs.create({
      name: 'daily',
      trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' },
      action: ACTION,
    });
    expect(() =>
      jobs.patch(job.id, {
        trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/Landon' },
      } as unknown as JobPatchBody),
    ).toThrowError(/invalid IANA timezone/);
    expect(jobs.get(job.id)!.trigger).toEqual({
      type: 'cron',
      expression: '0 9 * * *',
      timezone: 'Europe/London',
    });
  });
});

// The real HTTP surface every client writes through (spec/01 § Jobs API).
// The store-level tests above prove the gate; these prove a client actually
// reaches it, and gets a usable status + message back.
describe('POST/PATCH /api/jobs over the real HTTP route', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-crontz-rest-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function bootstrap(): Promise<{
    built: Awaited<ReturnType<typeof buildAll>>;
    auth: { authorization: string };
  }> {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(21));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-tz',
      surfaceKind: 'terminal',
      label: 'cli',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-tz',
      surfaceKind: 'terminal',
      label: 'cli',
    });
    const built = await buildAll({
      logger: false,
      registry,
      hostLink: new InProcessHostLink(),
    });
    return { built, auth: { authorization: `Bearer ${jwt}` } };
  }

  it('accepts a zoned cron trigger and returns it on the created job', async () => {
    const { built, auth } = await bootstrap();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: auth,
        payload: {
          name: 'daily email update',
          trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' },
          action: ACTION,
        },
      });
      expect(res.statusCode).toBe(201);
      expect((res.json() as { trigger: unknown }).trigger).toEqual({
        type: 'cron',
        expression: '0 9 * * *',
        timezone: 'Europe/London',
      });
    } finally {
      await built.app.close();
    }
  });

  it('400s an unresolvable zone with a message naming it', async () => {
    const { built, auth } = await bootstrap();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: auth,
        payload: {
          name: 'bad zone',
          trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/Landon' },
          action: ACTION,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.json())).toMatch(/timezone/);
      // Nothing was persisted.
      const list = await built.app.inject({ method: 'GET', url: '/api/jobs', headers: auth });
      expect((list.json() as { jobs: unknown[] }).jobs).toHaveLength(0);
    } finally {
      await built.app.close();
    }
  });

  it('a trigger with no zone round-trips with no zone', async () => {
    const { built, auth } = await bootstrap();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: auth,
        payload: {
          name: 'legacy',
          trigger: { type: 'cron', expression: '0 9 * * *' },
          action: ACTION,
        },
      });
      expect(res.statusCode).toBe(201);
      expect((res.json() as { trigger: unknown }).trigger).toEqual({
        type: 'cron',
        expression: '0 9 * * *',
      });
    } finally {
      await built.app.close();
    }
  });

  it('PATCH can add a zone to an existing job without touching its expression', async () => {
    const { built, auth } = await bootstrap();
    try {
      const created = await built.app.inject({
        method: 'POST',
        url: '/api/jobs',
        headers: auth,
        payload: {
          name: 'daily email update',
          trigger: { type: 'cron', expression: '0 9 * * *' },
          action: ACTION,
        },
      });
      const id = (created.json() as { id: string }).id;
      const patched = await built.app.inject({
        method: 'PATCH',
        url: `/api/jobs/${id}`,
        headers: auth,
        payload: { trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' } },
      });
      expect(patched.statusCode).toBe(200);
      expect((patched.json() as { trigger: unknown }).trigger).toEqual({
        type: 'cron',
        expression: '0 9 * * *',
        timezone: 'Europe/London',
      });
    } finally {
      await built.app.close();
    }
  });
});

// The bug itself, proven against the REAL scheduler via its real
// registration path (only the schedule function is wrapped, to get a handle
// on the task it actually built).
describe('DST: 0 9 * * * in Europe/London is 9am London all year', () => {
  let dir: string;
  let scheduler: CronScheduler | null = null;
  let task: CronTask | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-crontz-'));
  });
  afterEach(() => {
    if (scheduler) scheduler.stop();
    if (task) task.stop();
    scheduler = null;
    task = null;
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Register `expression` (+ optional `timezone`) through the real
   * CronScheduler at the fixed instant `nowIso`, and return the UTC instant
   * the scheduler will next fire it.
   */
  function nextRunUtc(nowIso: string, expression: string, timezone?: string): string {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(nowIso));
    const { jobs, dispatcher, logs } = makeDeps(dir);
    scheduler = new CronScheduler({
      jobs,
      dispatcher,
      logs,
      logger: silentLogger,
      schedule: ((expr: string, cb: () => Promise<void>, opts: { timezone?: string }) => {
        task = croner(expr, cb, opts as { timezone: string });
        return task;
      }) as unknown as ScheduleFn,
    });
    scheduler.start();
    jobs.create({
      name: 'daily email update',
      trigger: { type: 'cron', expression, ...(timezone ? { timezone } : {}) },
      action: ACTION,
    });
    const next = task!.nextRun();
    if (!next) throw new Error('scheduler reported no next run');
    return next.toISOString();
  }

  it('fires at 08:00 UTC in BST — the reported bug, inverted', () => {
    expect(nextRunUtc(SUMMER, '0 9 * * *', 'Europe/London')).toBe('2026-07-16T08:00:00.000Z');
  });

  it('fires at 09:00 UTC in GMT', () => {
    expect(nextRunUtc(WINTER, '0 9 * * *', 'Europe/London')).toBe('2026-01-16T09:00:00.000Z');
  });

  it('a job with NO zone still fires at 09:00 UTC in summer — old behaviour preserved', () => {
    // This is the pre-fix behaviour and it must NOT change: every job stored
    // before the field existed relies on it. It is also exactly why the bug
    // looked like "9am fires at 10am" to a person in London.
    expect(nextRunUtc(SUMMER, '0 9 * * *')).toBe('2026-07-16T09:00:00.000Z');
  });

  it('an explicit UTC zone matches an absent one', () => {
    expect(nextRunUtc(SUMMER, '0 9 * * *', 'UTC')).toBe('2026-07-16T09:00:00.000Z');
  });

  it('a zone on the far side of the world shifts the day, not just the hour', () => {
    // Sanity that the zone is genuinely applied rather than nudged: 09:00 in
    // Auckland (UTC+12 in July) on 16 Jul is 21:00 UTC on 15 Jul.
    expect(nextRunUtc(SUMMER, '0 9 * * *', 'Pacific/Auckland')).toBe('2026-07-15T21:00:00.000Z');
  });
});

// 25 Oct 2026: the clocks went back at 02:00 BST and node-cron 4.2 silenced
// every daily London job — after Saturday's 08:00 run it put the next one on
// 1 Jan. Each case starts just after the previous day's fire, as the live
// scheduler does.
describe('DST transitions: every daily job fires exactly once a day', () => {
  /** The next `count` fire instants after `fromIso`, in UTC. */
  function nextRuns(expression: string, fromIso: string, count: number): string[] {
    const task = croner(expression, async () => undefined, { timezone: 'Europe/London' });
    const out: string[] = [];
    let from = new Date(fromIso);
    try {
      for (let i = 0; i < count; i++) {
        const next = (task as unknown as { nextRun(prev: Date): Date | null }).nextRun(from);
        if (!next) throw new Error('scheduler reported no next run');
        out.push(next.toISOString());
        from = next;
      }
    } finally {
      task.stop();
    }
    return out;
  }

  it('autumn: an 08:00 job fires at 08:00 London on the change day and after', () => {
    expect(nextRuns('0 8 * * *', '2026-10-24T07:00:01Z', 2)).toEqual([
      '2026-10-25T08:00:00.000Z',
      '2026-10-26T08:00:00.000Z',
    ]);
  });

  it('autumn: a 02:00 and a 03:15 job fire on the change day', () => {
    expect(nextRuns('0 2 * * *', '2026-10-24T01:00:01Z', 1)).toEqual(['2026-10-25T02:00:00.000Z']);
    expect(nextRuns('15 3 * * *', '2026-10-24T02:15:01Z', 1)).toEqual(['2026-10-25T03:15:00.000Z']);
  });

  it('autumn: a job in the repeated hour fires once, not twice', () => {
    expect(nextRuns('30 1 * * *', '2026-10-24T00:30:01Z', 2)).toEqual([
      '2026-10-25T00:30:00.000Z',
      '2026-10-26T01:30:00.000Z',
    ]);
  });

  it('autumn: midnight fires at midnight London either side of the change', () => {
    expect(nextRuns('0 0 * * *', '2026-10-23T23:00:01Z', 2)).toEqual([
      '2026-10-24T23:00:00.000Z',
      '2026-10-26T00:00:00.000Z',
    ]);
  });

  it('spring: a job in the skipped hour still fires that day, just after the jump', () => {
    expect(nextRuns('30 1 * * *', '2027-03-27T01:30:01Z', 2)).toEqual([
      '2027-03-28T01:30:00.000Z',
      '2027-03-29T00:30:00.000Z',
    ]);
  });

  it('spring: an 08:00 job moves from 08:00 to 07:00 UTC', () => {
    expect(nextRuns('0 8 * * *', '2027-03-27T08:00:01Z', 2)).toEqual([
      '2027-03-28T07:00:00.000Z',
      '2027-03-29T07:00:00.000Z',
    ]);
  });

  it('a weekly Monday job straddling the change keeps its local time', () => {
    expect(nextRuns('0 8 * * 1', '2026-10-19T07:00:01Z', 2)).toEqual([
      '2026-10-26T08:00:00.000Z',
      '2026-11-02T08:00:00.000Z',
    ]);
  });
});
