// A job's chat key is rendered from Mustache before any prompt is, so the
// dispatcher's "no HTML escaping" has to hold for the very first keyed fire
// after a restart — not only after the first prompt render. Otherwise the
// first fire slugs `Fix A/B & C` as `Fix-A-x2F-B-amp-C` and every later fire
// as `Fix-A-B-C`: two different chats for one subject. Escaping is chosen per
// render, so the shared `mustache` module is left as every other user expects.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import Mustache from 'mustache';
import { InProcessHostLink } from '../src/host-link.js';
import { JobLogs } from '../src/jobs/logs.js';
import { JobDispatcher } from '../src/jobs/dispatcher.js';
import type { Job } from '../src/jobs/types.js';

describe('dispatcher Mustache setup', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('keys the first fire after a restart the same as every later one, and leaves the shared module alone', () => {
    dir = mkdtempSync(join(tmpdir(), 'patch-mustache-'));
    const link = new InProcessHostLink();
    const disp = new JobDispatcher({
      dataDir: dir,
      logs: new JobLogs(dir),
      hostLink: link,
      logger: pino({ level: 'silent' }),
      idGenerator: () => 'fid',
    });
    const job: Job = {
      id: 'j_0000000000000000000mustache',
      name: 'keyed',
      enabled: true,
      trigger: { type: 'cron', expression: '* * * * *' },
      filter: null,
      action: { type: 'continue', hostId: 'd1', folder: '/persist', prompt: 'go', key: '{{task}}' },
      createdAt: 1,
      updatedAt: 1,
    };
    disp.dispatch(job, { task: 'Fix A/B & C' }, 'webhook');
    const spawn = link.sent.find((s) => s.event.type === 'chat.spawn_request')?.event;
    expect(spawn?.type).toBe('chat.spawn_request');
    const chatId = spawn && spawn.type === 'chat.spawn_request' ? spawn.chatId : '';
    expect(chatId).toContain('Fix-A-B-C');
    expect(chatId).not.toMatch(/x2F|amp/);
    disp.close();
    // Everyone else's Mustache still escapes, as the library does by default.
    expect(Mustache.render('{{a}}', { a: 'A/B & C' })).toBe('A&#x2F;B &amp; C');
  });
});
