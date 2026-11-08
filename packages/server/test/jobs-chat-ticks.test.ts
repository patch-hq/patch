// GET /api/chats/:chatId/jobs — the scheduled jobs behind a chat's job bar.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { ensureChatId, jobTargetsChat } from '@patch/wire/jobs';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

describe('chat job ticks', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-job-ticks-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function bootstrap() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(21));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-t',
      surfaceKind: 'terminal',
      label: 'cli',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-t',
      surfaceKind: 'terminal',
      label: 'cli',
    });
    const built = await buildAll({ logger: false, registry, hostLink: new InProcessHostLink() });
    return { built, headers: { authorization: `Bearer ${jwt}` } };
  }

  it('lists enabled cron jobs that message the chat, with next fire and period', async () => {
    const { built, headers } = await bootstrap();
    try {
      const job = built.jobs.create({
        name: 'every five',
        trigger: { type: 'cron', expression: '*/5 * * * *' },
        action: { type: 'message', chatId: 'chat-1', prompt: 'go' },
      });
      built.jobs.create({
        name: 'other chat',
        trigger: { type: 'cron', expression: '*/5 * * * *' },
        action: { type: 'message', chatId: 'chat-2', prompt: 'go' },
      });
      built.jobs.create({
        name: 'disabled',
        enabled: false,
        trigger: { type: 'cron', expression: '*/5 * * * *' },
        action: { type: 'message', chatId: 'chat-1', prompt: 'go' },
      });
      const res = await built.app.inject({ method: 'GET', url: '/api/chats/chat-1/jobs', headers });
      expect(res.statusCode).toBe(200);
      const { jobs } = res.json();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        jobId: job.id,
        name: 'every five',
        trigger: 'cron',
        schedule: '*/5 * * * *',
        periodMs: 300_000,
      });
      expect(jobs[0].nextFireAt).toBeGreaterThan(Date.now() - 1000);
      expect(jobs[0].nextFireAt).toBeLessThanOrEqual(Date.now() + 300_000);
    } finally {
      await built.app.close();
    }
  });

  it("finds a continue job's own chat", async () => {
    const { built, headers } = await bootstrap();
    try {
      const job = built.jobs.create({
        name: 'owns a chat',
        trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' },
        action: { type: 'continue', hostId: 'h', folder: '/x', prompt: 'go' },
      });
      const res = await built.app.inject({
        method: 'GET',
        url: `/api/chats/${ensureChatId(job.id)}/jobs`,
        headers,
      });
      expect(res.json().jobs.map((j: { jobId: string }) => j.jobId)).toEqual([job.id]);
    } finally {
      await built.app.close();
    }
  });

  it('ignores event-triggered jobs and needs auth', async () => {
    const { built, headers } = await bootstrap();
    try {
      built.jobs.create({
        name: 'hook',
        trigger: { type: 'webhook' },
        action: { type: 'message', chatId: 'chat-1', prompt: 'go' },
      });
      const ok = await built.app.inject({ method: 'GET', url: '/api/chats/chat-1/jobs', headers });
      expect(ok.json().jobs).toEqual([]);
      const anon = await built.app.inject({ method: 'GET', url: '/api/chats/chat-1/jobs' });
      expect(anon.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('jobTargetsChat covers keyed and append-generation continue chats', () => {
    const job = {
      id: 'j_X',
      action: { type: 'continue', hostId: 'h', folder: '/x', prompt: 'p' },
    } as Parameters<typeof jobTargetsChat>[0];
    expect(jobTargetsChat(job, 'jobchat-j_X')).toBe(true);
    expect(jobTargetsChat(job, 'jobchat-j_X-subject')).toBe(true);
    expect(jobTargetsChat(job, 'jobchat-j_XY')).toBe(false);
  });
});
