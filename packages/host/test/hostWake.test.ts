import { describe, it, expect } from 'vitest';
import pino from 'pino';
import type { HostWakeRequestEvent, WireEvent } from '@patch/wire';
import { handleHostWake, pmsetDate } from '../src/hostWake.js';

const logger = pino({ level: 'silent' });
const AT = new Date(2026, 9, 16, 2, 59, 0).getTime();
const req: HostWakeRequestEvent = { type: 'host.wake_request', hostId: 'h1', jobId: 'j1', at: AT };

function harness(opts: { platform?: NodeJS.Platform; batt?: string; sudoFails?: string }) {
  const sent: WireEvent[] = [];
  const calls: string[][] = [];
  const run = async (cmd: string, args: string[]): Promise<string> => {
    calls.push([cmd, ...args]);
    if (cmd === 'pmset') return opts.batt ?? "Now drawing from 'AC Power'";
    if (opts.sudoFails) throw new Error(opts.sudoFails);
    return '';
  };
  return {
    sent,
    calls,
    go: () =>
      handleHostWake(req, (e) => sent.push(e), logger, {
        platform: opts.platform ?? 'darwin',
        run,
      }),
  };
}

describe('handleHostWake', () => {
  it('formats the date the way pmset takes it', () => {
    expect(pmsetDate(AT)).toBe('10/16/2026 02:59:00');
  });
  it('schedules a wake on AC power and reports ok', async () => {
    const h = harness({});
    await h.go();
    expect(h.calls.at(-1)).toEqual([
      'sudo',
      '-n',
      'pmset',
      'schedule',
      'wake',
      '10/16/2026 02:59:00',
    ]);
    expect(h.sent).toEqual([{ type: 'host.wake_result', jobId: 'j1', at: AT, ok: true }]);
  });
  it('refuses on battery and says so', async () => {
    const h = harness({ batt: "Now drawing from 'Battery Power'" });
    await h.go();
    expect(h.calls.some((c) => c[0] === 'sudo')).toBe(false);
    expect(h.sent[0]).toMatchObject({ ok: false, error: 'the host is not on AC power' });
  });
  it('reports a sudo failure verbatim', async () => {
    const h = harness({ sudoFails: 'sudo: a password is required' });
    await h.go();
    expect(h.sent[0]).toMatchObject({ ok: false, error: 'sudo: a password is required' });
  });
  it('refuses on non-macOS hosts', async () => {
    const h = harness({ platform: 'linux' });
    await h.go();
    expect(h.sent[0]).toMatchObject({ ok: false });
    expect(h.calls).toHaveLength(0);
  });
});
