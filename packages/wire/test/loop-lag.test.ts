import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchLoopLag } from '../src/loop-lag.js';

describe('watchLoopLag', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reports a tick that ran late by more than the threshold, and only that', () => {
    const lags: number[] = [];
    const stop = watchLoopLag({
      thresholdMs: 200,
      intervalMs: 100,
      onLag: (l) => lags.push(l),
      now: () => Date.now(),
    });
    vi.advanceTimersByTime(1000);
    expect(lags).toEqual([]);
    // A stall: the clock jumps 500 ms without the timer running.
    vi.setSystemTime(Date.now() + 500);
    vi.advanceTimersByTime(100);
    expect(lags).toHaveLength(1);
    expect(lags[0]).toBeGreaterThanOrEqual(500);
    stop();
  });
});
