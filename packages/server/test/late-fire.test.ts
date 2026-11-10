import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { NotificationLog } from '../src/notifications/log.js';
import { lateFireHandler } from '../src/jobs/late-fire.js';

describe('lateFireHandler', () => {
  it('records a silent bell entry for the job and has no way to push', () => {
    const log = new NotificationLog({ logger: pino({ level: 'silent' }) });
    lateFireHandler(log)({
      jobId: 'j1',
      jobName: 'Morning bus',
      fireId: 'f1',
      hostId: 'mac',
      dueAt: Date.UTC(2026, 9, 28, 7, 0),
      chatId: 'c1',
      timezone: 'UTC',
    });
    const [entry] = log.snapshot().items;
    expect(log.snapshot().items).toHaveLength(1);
    expect(entry?.importance).toBe('silent');
    expect(entry?.jobId).toBe('j1');
    expect(entry?.message).toBe(
      'Morning bus has not run: host mac unreachable since 07:00. It will run when the host is back.',
    );
  });
});
