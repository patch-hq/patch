// Job alerts: a failed dispatch / broken gate stays visible until dismissed or
// the job's next run succeeds. Unit coverage of the store, then the same flow
// through a running server (real cron fire, the host's real refusal, REST).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';
import { JobAlerts, describeFailure } from '../src/jobs/alerts.js';
import type { RunLogEntry } from '../src/jobs/logs.js';
import { hostConfirms } from './host-answer.js';

const JOB = 'j_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER = 'j_01ARZ3NDEKTSV4RRFFQ69G5FAW';
const silent = pino({ level: 'silent' });

const run = (status: RunLogEntry['status'], over: Partial<RunLogEntry> = {}): RunLogEntry => ({
  ts: 1000,
  jobId: JOB,
  status,
  trigger: 'cron',
  ...over,
});

describe('describeFailure', () => {
  it('turns a ChatGPT-login refusal into plain words with the fix', () => {
    const d = describeFailure(
      'dispatch-error',
      'host H1 refused the action: chatgpt_login_required: not signed in',
    );
    expect(d.reason).toMatch(/ChatGPT is not signed in/);
    expect(d.fix).toBe('Sign in to ChatGPT in Settings → Hosts.');
    expect(d.fixPath).toBe('/settings/hosts');
  });

  it('names a missing folder', () => {
    const d = describeFailure('dispatch-error', 'host H1 refused the action: folder_not_found: x');
    expect(d.reason).toMatch(/folder does not exist/);
  });

  it('keeps the raw text for an error it has no words for', () => {
    const d = describeFailure('dispatch-error', 'host H1 did not confirm the action within 20s');
    expect(d.reason).toBe('host H1 did not confirm the action within 20s');
    expect(d.fix).toMatch(/run log/);
  });

  it('describes a broken gate', () => {
    const d = describeFailure('gate-error', 'gate exited 2');
    expect(d.reason).toContain('gate exited 2');
    expect(d.fix).toMatch(/gate script/);
  });
});

describe('JobAlerts', () => {
  let dir: string;
  const names: Record<string, string> = { [JOB]: 'Cadence monitor agents', [OTHER]: 'Other' };
  const make = () => new JobAlerts(dir, (id) => names[id] ?? null, silent);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-job-alerts-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('raises an alert naming the job on dispatch-error', () => {
    const a = make();
    a.onRun(
      run('dispatch-error', { error: 'host H refused the action: chatgpt_login_required: x' }),
    );
    expect(a.list()).toMatchObject([
      { jobId: JOB, jobName: 'Cadence monitor agents', status: 'dispatch-error', ts: 1000 },
    ]);
  });

  it('raises an alert on gate-error', () => {
    const a = make();
    a.onRun(run('gate-error', { error: 'boom' }));
    expect(a.list()[0]?.status).toBe('gate-error');
  });

  it.each(['gate-held', 'filter-rejected', 'queued', 'buffered', 'chat-error'] as const)(
    'ignores %s',
    (status) => {
      const a = make();
      a.onRun(run(status));
      expect(a.list()).toEqual([]);
    },
  );

  it('keeps the alert through non-success runs and clears it on ok', () => {
    const a = make();
    a.onRun(run('dispatch-error', { error: 'x' }));
    a.onRun(run('gate-held', { ts: 2000 }));
    expect(a.list()).toHaveLength(1);
    a.onRun(run('ok', { ts: 3000 }));
    expect(a.list()).toEqual([]);
  });

  it('an ok from another job leaves the alert alone', () => {
    const a = make();
    a.onRun(run('dispatch-error', { error: 'x' }));
    a.onRun(run('ok', { jobId: OTHER }));
    expect(a.list()).toHaveLength(1);
  });

  it('a newer failure replaces the older one; list is newest first', () => {
    const a = make();
    a.onRun(run('dispatch-error', { error: 'old', ts: 1 }));
    a.onRun(run('dispatch-error', { error: 'new', ts: 5 }));
    a.onRun(run('gate-error', { jobId: OTHER, error: 'g', ts: 3 }));
    expect(a.list().map((x) => [x.jobId, x.detail])).toEqual([
      [JOB, 'new'],
      [OTHER, 'g'],
    ]);
  });

  it('onRun reports a new alert once, not on every repeat failure', () => {
    const a = make();
    expect(a.onRun(run('gate-error', { error: 'x', ts: 1 }))).toBe(true);
    expect(a.onRun(run('gate-error', { error: 'x', ts: 2 }))).toBe(false);
    expect(a.onRun(run('ok', { ts: 3 }))).toBe(false);
    expect(a.onRun(run('gate-error', { error: 'x', ts: 4 }))).toBe(true);
  });

  it('dismiss removes the alert, once', () => {
    const a = make();
    a.onRun(run('dispatch-error', { error: 'x' }));
    expect(a.dismiss(JOB)).toBe(true);
    expect(a.dismiss(JOB)).toBe(false);
    expect(a.list()).toEqual([]);
  });

  it('survives a restart, and a dismissal survives too', () => {
    const a = make();
    a.onRun(run('dispatch-error', { error: 'x' }));
    expect(make().list()).toHaveLength(1);
    a.dismiss(JOB);
    expect(make().list()).toEqual([]);
  });

  it('drops the alert of a job that no longer exists', () => {
    const a = make();
    a.onRun(run('dispatch-error', { jobId: 'j_01ARZ3NDEKTSV4RRFFQ69G5FAX', error: 'x' }));
    expect(a.list()).toEqual([]);
  });

  it('reads a corrupt file as no alerts instead of throwing, and recovers', () => {
    writeFileSync(join(dir, 'job-alerts.json'), '{not json');
    const a = make();
    expect(a.list()).toEqual([]);
    a.onRun(run('dispatch-error', { error: 'x' }));
    expect(JSON.parse(readFileSync(join(dir, 'job-alerts.json'), 'utf8'))[JOB]).toBeDefined();
  });
});

describe('job alerts through a running server', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-job-alerts-e2e-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a refused fire raises an alert; the next ok run clears it; dismiss works', async () => {
    const user = generateUserKeypair();
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 's', surfaceKind: 'desktop', label: 's', issuedAt: 1 });
    const hostLink = new InProcessHostLink();
    const built = await buildAll({ logger: false, registry, hostLink });
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(built.app.server.address() as AddressInfo).port}`;
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 's',
      surfaceKind: 'desktop',
      label: 's',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(base + path, {
        method,
        headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, json: (await r.json().catch(() => null)) as any };
    };
    try {
      expect((await fetch(`${base}/api/job-alerts`)).status).toBe(401);
      const created = await call('POST', '/api/jobs', {
        name: 'Cadence monitor agents',
        trigger: { type: 'cron', expression: '0 8 * * *' },
        action: { type: 'spawn', hostId: 'd1', folder: '/work', prompt: 'go' },
      });
      const jobId = created.json.id as string;
      expect((await call('GET', '/api/job-alerts')).json.alerts).toEqual([]);

      // The host refuses the fire.
      await built.cronScheduler.fireForTesting(jobId);
      const spawn = hostLink.sent.find((s) => s.event.type === 'chat.spawn_request')!.event as any;
      hostLink.emit({
        type: 'chat.error',
        chatId: spawn.chatId,
        error: { code: 'chatgpt_login_required', message: 'sign in' },
        seq: -1,
      });
      const listed = (await call('GET', '/api/job-alerts')).json.alerts;
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        jobId,
        jobName: 'Cadence monitor agents',
        status: 'dispatch-error',
        fix: 'Sign in to ChatGPT in Settings → Hosts.',
      });

      // Next run succeeds: alert goes.
      const before = hostLink.sent.length;
      await built.cronScheduler.fireForTesting(jobId);
      expect(hostLink.sent.length).toBeGreaterThan(before);
      hostConfirms(hostLink);
      expect((await call('GET', '/api/job-alerts')).json.alerts).toEqual([]);

      // Fail again, dismiss by hand.
      await built.cronScheduler.fireForTesting(jobId);
      const spawn2 = hostLink.sent.filter((s) => s.event.type === 'chat.spawn_request').at(-1)!
        .event as any;
      hostLink.emit({
        type: 'chat.error',
        chatId: spawn2.chatId,
        error: { code: 'folder_not_found', message: 'nope' },
        seq: -1,
      });
      expect((await call('GET', '/api/job-alerts')).json.alerts).toHaveLength(1);
      expect((await call('DELETE', `/api/job-alerts/${jobId}`)).status).toBe(200);
      expect((await call('DELETE', `/api/job-alerts/${jobId}`)).status).toBe(404);
      expect((await call('GET', '/api/job-alerts')).json.alerts).toEqual([]);
    } finally {
      built.wsHub.shutdown();
      built.callOrchestrator.shutdown();
      await built.app.close();
    }
  });
});
