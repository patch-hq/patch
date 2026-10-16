// `wakeHost` is stored and patched like any other job field (spec/08 § Wake host).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { JobStore } from '../src/jobs/store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('wakeHost', () => {
  it('is saved on create, survives a reload and can be switched off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-wake-'));
    dirs.push(dir);
    const mk = (): JobStore =>
      new JobStore({ dataDir: dir, logger: pino({ level: 'silent' }), watch: false });
    const store = mk();
    const job = store.create({
      name: 'Daily reset',
      trigger: { type: 'cron', expression: '0 3 * * *', timezone: 'Europe/London' },
      action: { type: 'spawn', hostId: 'd1', folder: '/work', prompt: 'go' },
      wakeHost: true,
    });
    expect(job.wakeHost).toBe(true);
    await store.close();
    const reloaded = mk();
    expect(reloaded.get(job.id)?.wakeHost).toBe(true);
    expect(reloaded.patch(job.id, { wakeHost: false }).wakeHost).toBe(false);
    await reloaded.close();
  });
});
