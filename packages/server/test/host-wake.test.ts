import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { InProcessHostLink } from '../src/host-link.js';
import { HostWaker } from '../src/jobs/host-wake.js';
import type { Job } from '../src/jobs/types.js';

const NOW = Date.UTC(2026, 9, 16, 1, 0, 0);
const NEXT = NOW + 2 * 3600_000;

function job(over: Partial<Job> = {}): Job {
  return {
    id: 'j1',
    name: 'Daily reset',
    enabled: true,
    trigger: { type: 'cron', expression: '0 3 * * *', timezone: 'Europe/London' },
    filter: null,
    action: { type: 'spawn', hostId: 'd1', folder: '/work', prompt: 'go' },
    createdAt: 1,
    updatedAt: 1,
    wakeHost: true,
    ...over,
  };
}

function setup(jobs: Job[], next: Date | null = new Date(NEXT)) {
  const link = new InProcessHostLink();
  const failures: Array<{ error: string; hostId: string | null }> = [];
  const waker = new HostWaker({
    jobs: { list: () => jobs },
    hostLink: link,
    logger: pino({ level: 'silent' }),
    nextRun: () => next,
    hostFor: (j) => (j.action.type === 'message' ? null : j.action.hostId),
    onFailure: (f) => failures.push({ error: f.error, hostId: f.hostId }),
    nowMs: () => NOW,
  });
  return { link, waker, failures };
}

describe('HostWaker', () => {
  it('asks the online host to wake a minute before the next fire, once', () => {
    const { link, waker } = setup([job()]);
    link.setHostId('d1');
    waker.tick();
    waker.tick();
    expect(link.sent).toHaveLength(1);
    expect(link.sent[0]!.event).toEqual({
      type: 'host.wake_request',
      hostId: 'd1',
      jobId: 'j1',
      at: NEXT - 60_000,
    });
  });

  it('ignores jobs without wakeHost, disabled jobs and hosts that are offline', () => {
    const a = setup([job({ wakeHost: false })]);
    a.link.setHostId('d1');
    a.waker.tick();
    const b = setup([job({ enabled: false })]);
    b.link.setHostId('d1');
    b.waker.tick();
    const c = setup([job()]);
    c.link.setHostId('other');
    c.waker.tick();
    expect(a.link.sent.length + b.link.sent.length + c.link.sent.length).toBe(0);
  });

  it('raises a failure when the host reports it could not schedule', () => {
    const { link, waker, failures } = setup([job()]);
    link.setHostId('d1');
    waker.start();
    link.emit({
      type: 'host.wake_result',
      jobId: 'j1',
      at: NEXT - 60_000,
      ok: false,
      error: 'the host is not on AC power',
    });
    expect(failures).toEqual([{ error: 'the host is not on AC power', hostId: 'd1' }]);
    waker.stop();
  });

  it('stays quiet on a successful result', () => {
    const { link, waker, failures } = setup([job()]);
    link.setHostId('d1');
    waker.start();
    link.emit({ type: 'host.wake_result', jobId: 'j1', at: NEXT - 60_000, ok: true });
    expect(failures).toHaveLength(0);
    waker.stop();
  });
});
