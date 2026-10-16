import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { createSleepGuard } from '../src/sleepGuard.js';

const logger = pino({ level: 'silent' });

function fake() {
  const kill = vi.fn();
  const spawn = vi.fn((_c: string, _a: string[]) => ({ kill, on: vi.fn() }));
  return { kill, spawn };
}

describe('sleepGuard', () => {
  it('does nothing off macOS', () => {
    const { spawn } = fake();
    createSleepGuard({ logger, platform: 'linux', spawn }).acquire()();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('runs one caffeinate tied to the daemon pid for all concurrent holders', () => {
    const { spawn, kill } = fake();
    const g = createSleepGuard({ logger, platform: 'darwin', pid: 42, spawn });
    const r1 = g.acquire();
    const r2 = g.acquire();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('/usr/bin/caffeinate', ['-i', '-s', '-w', '42']);
    r1();
    r1();
    expect(kill).not.toHaveBeenCalled();
    r2();
    expect(kill).toHaveBeenCalledTimes(1);
    g.acquire();
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});
