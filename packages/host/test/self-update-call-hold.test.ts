// spec/02 § Self-update holds for calls: installing an update restarts the
// host, which would cut a live call, so the update waits for calls to end —
// for a bounded time, so a call left open does not block updates for ever.

import { describe, it, expect } from 'vitest';
import { waitForCallsToEnd, CALL_HOLD_MAX_MS } from '../src/selfUpdate.js';

const logger = { info() {}, warn() {}, error() {} } as never;

function clock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

describe('waitForCallsToEnd', () => {
  it('goes straight through when no call is open', async () => {
    const c = clock();
    expect(await waitForCallsToEnd({ activeCount: () => 0, logger, ...c })).toBe('clear');
    expect(c.now()).toBe(0);
  });

  it('holds while a call is open and installs once it ends', async () => {
    const c = clock();
    let open = 1;
    const result = waitForCallsToEnd({
      activeCount: () => {
        if (c.now() >= 30_000) open = 0;
        return open;
      },
      logger,
      pollMs: 10_000,
      ...c,
    });
    expect(await result).toBe('clear');
    expect(c.now()).toBe(30_000);
  });

  it('installs anyway once the longest hold has passed', async () => {
    const c = clock();
    expect(await waitForCallsToEnd({ activeCount: () => 1, logger, pollMs: 60_000, ...c })).toBe(
      'timed-out',
    );
    expect(c.now()).toBeGreaterThanOrEqual(CALL_HOLD_MAX_MS);
  });
});
