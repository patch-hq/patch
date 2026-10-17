// Host shutdown must end the process within a fixed budget, because a
// self-update's `launchctl bootout` waits for it (see src/shutdownDeadline.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shutdownThenExit } from '../src/shutdownDeadline.js';

describe('shutdownThenExit', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('exits 0 as soon as a graceful shutdown finishes', async () => {
    const exit = vi.fn();
    const onDeadline = vi.fn();
    shutdownThenExit(() => Promise.resolve(), { exit, onDeadline, deadlineMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledWith(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(onDeadline).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits at the deadline when a shutdown step never returns', async () => {
    const exit = vi.fn();
    const onDeadline = vi.fn();
    shutdownThenExit(() => new Promise<void>(() => undefined), {
      exit,
      onDeadline,
      deadlineMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onDeadline).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 1 when shutdown throws', async () => {
    const exit = vi.fn();
    shutdownThenExit(() => Promise.reject(new Error('boom')), {
      exit,
      onDeadline: vi.fn(),
      deadlineMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
