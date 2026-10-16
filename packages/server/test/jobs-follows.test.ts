// Follows trigger (spec/08 § Follows): a job that fires when another job's run
// settles. Store validation (exists, no loops) and dispatcher fan-out.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { InProcessHostLink } from '../src/host-link.js';
import { JobDispatcher } from '../src/jobs/dispatcher.js';
import { JobLogs } from '../src/jobs/logs.js';
import { JobStore } from '../src/jobs/store.js';

const silentLogger = pino({ level: 'silent' });
const CRON = { type: 'cron', expression: '* * * * *' } as const;
const ACTION = { type: 'spawn', hostId: 'd1', folder: '/work', prompt: 'go' } as const;

describe('follows trigger', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-follows-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const makeStore = (): JobStore =>
    new JobStore({ dataDir: dir, logger: silentLogger, watch: false });

  describe('store validation', () => {
    it('accepts a follower of an existing job', async () => {
      const store = makeStore();
      try {
        const a = store.create({ name: 'a', trigger: CRON, action: ACTION });
        const b = store.create({
          name: 'b',
          trigger: { type: 'follows', jobId: a.id },
          action: ACTION,
        });
        expect(b.trigger).toEqual({ type: 'follows', jobId: a.id });
      } finally {
        await store.close();
      }
    });

    it('refuses a followed job that does not exist', async () => {
      const store = makeStore();
      try {
        expect(() =>
          store.create({
            name: 'b',
            trigger: { type: 'follows', jobId: 'j_nope' },
            action: ACTION,
          }),
        ).toThrow(/not found/);
      } finally {
        await store.close();
      }
    });

    it('refuses a job following itself and a loop through a chain', async () => {
      const store = makeStore();
      try {
        const a = store.create({ name: 'a', trigger: CRON, action: ACTION });
        const b = store.create({
          name: 'b',
          trigger: { type: 'follows', jobId: a.id },
          action: ACTION,
        });
        expect(() => store.patch(a.id, { trigger: { type: 'follows', jobId: a.id } })).toThrow(
          /cannot follow itself/,
        );
        expect(() => store.patch(a.id, { trigger: { type: 'follows', jobId: b.id } })).toThrow(
          /cannot follow itself/,
        );
      } finally {
        await store.close();
      }
    });
  });

  describe('dispatcher', () => {
    function setup() {
      const link = new InProcessHostLink();
      const store = makeStore();
      const logs = new JobLogs(dir);
      let n = 0;
      const disp = new JobDispatcher({
        dataDir: dir,
        hostLink: link,
        logger: silentLogger,
        logs,
        jobs: store,
        idGenerator: () => `fire${++n}`,
        ackTimeoutMs: 5_000,
      });
      const lead = store.create({ name: 'lead', trigger: CRON, action: ACTION });
      const okOnly = store.create({
        name: 'ok-only',
        trigger: { type: 'follows', jobId: lead.id },
        action: ACTION,
      });
      const anyOutcome = store.create({
        name: 'any',
        trigger: { type: 'follows', jobId: lead.id, on: 'any' },
        action: ACTION,
      });
      const fireLead = (): string => disp.dispatch(lead, {}, 'cron').event.chatId as string;
      // Each fire sends one spawn_request; the request's prompt carries no job id,
      // so count them: 1 is the lead, every follower fired adds one.
      const spawns = (): number =>
        link.sent.filter((x) => x.event.type === 'chat.spawn_request').length;
      return { link, store, disp, lead, okOnly, anyOutcome, fireLead, spawns };
    }
    const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

    it('a run settling ok fires both followers', async () => {
      const s = setup();
      try {
        const chatId = s.fireLead();
        s.link.emit({ type: 'chat.spawned', chatId, hostId: 'd1', folder: '/work' });
        await tick();
        expect(s.spawns()).toBe(3);
      } finally {
        s.disp.close();
        await s.store.close();
      }
    });

    it('a failed run fires only the follower that asked for any outcome', async () => {
      const s = setup();
      try {
        const chatId = s.fireLead();
        s.link.emit({
          type: 'chat.error',
          chatId,
          error: { code: 'folder_not_found', message: 'no such folder' },
          seq: -1,
        });
        await tick();
        expect(s.spawns()).toBe(2);
      } finally {
        s.disp.close();
        await s.store.close();
      }
    });

    it('a disabled follower does not fire', async () => {
      const s = setup();
      try {
        s.store.disable(s.okOnly.id);
        const chatId = s.fireLead();
        s.link.emit({ type: 'chat.spawned', chatId, hostId: 'd1', folder: '/work' });
        await tick();
        expect(s.spawns()).toBe(2);
      } finally {
        s.disp.close();
        await s.store.close();
      }
    });
  });
});
