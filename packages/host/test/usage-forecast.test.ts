// Predicting when an account runs out from successive probes, and acting on it.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import {
  NEARLY_OUT_MS,
  PROBE_FAST_MS,
  PROBE_MEDIUM_MS,
  PROBE_SLOW_MS,
  probeIntervalMs,
  projectRunOut,
} from '../src/usageForecast.js';
import { AccountUsageTracker } from '../src/accountUsage.js';
import { AccountRotation } from '../src/accountFailover.js';
import type { ClaudeStoredAccount, ClaudeUsageResult } from '@patch/auth';

const MIN = 60_000;
const T0 = 1_800_000_000_000;
const RESET = T0 + 5 * 60 * MIN;

describe('projectRunOut', () => {
  it('extrapolates the burn rate to 98%', () => {
    // 0% -> 50% in 35 min is ~1.43%/min; 48% more takes ~33.6 min.
    const at = projectRunOut(
      [
        { at: T0, utilization: 0, resetsAt: RESET },
        { at: T0 + 35 * MIN, utilization: 0.5, resetsAt: RESET },
      ],
      45 * MIN,
      T0 + 35 * MIN,
    )!;
    expect((at - (T0 + 35 * MIN)) / MIN).toBeCloseTo(33.6, 0);
  });

  it('says nothing from a single reading, or with no growth', () => {
    const one = [{ at: T0, utilization: 0.5, resetsAt: RESET }];
    expect(projectRunOut(one, 45 * MIN, T0)).toBeUndefined();
    const flat = [...one, { at: T0 + 10 * MIN, utilization: 0.5, resetsAt: RESET }];
    expect(projectRunOut(flat, 45 * MIN, T0 + 10 * MIN)).toBeUndefined();
  });

  it('says nothing when the window resets first', () => {
    const reset = T0 + 20 * MIN;
    const s = [
      { at: T0, utilization: 0.1, resetsAt: reset },
      { at: T0 + 10 * MIN, utilization: 0.2, resetsAt: reset },
    ];
    expect(projectRunOut(s, 45 * MIN, T0 + 10 * MIN)).toBeUndefined();
  });

  it('ignores readings from the previous window', () => {
    const s = [
      { at: T0, utilization: 0.9, resetsAt: T0 + MIN },
      { at: T0 + 20 * MIN, utilization: 0.1, resetsAt: RESET },
      { at: T0 + 30 * MIN, utilization: 0.2, resetsAt: RESET },
    ];
    const at = projectRunOut(s, 45 * MIN, T0 + 30 * MIN)!;
    expect((at - (T0 + 30 * MIN)) / MIN).toBeCloseTo(78, 0);
  });

  it('is already out at 98%', () => {
    const s = [{ at: T0, utilization: 0.99, resetsAt: RESET }];
    expect(projectRunOut(s, 45 * MIN, T0)).toBe(T0);
  });

  it('says nothing once the window it described has reset', () => {
    const s = [{ at: T0, utilization: 0.99, resetsAt: T0 + MIN }];
    expect(projectRunOut(s, 45 * MIN, T0 + 2 * MIN)).toBeUndefined();
  });
});

describe('probeIntervalMs', () => {
  it('probes every 10 minutes when far from a limit, faster as it nears', () => {
    expect(probeIntervalMs([{ scope: 'session', utilization: 0.2 }], T0)).toBe(PROBE_SLOW_MS);
    expect(probeIntervalMs([{ scope: 'session', utilization: 0.8 }], T0)).toBe(PROBE_MEDIUM_MS);
    expect(probeIntervalMs([{ scope: 'session', utilization: 0.92 }], T0)).toBe(PROBE_FAST_MS);
    expect(
      probeIntervalMs([{ scope: 'session', utilization: 0.3, runOutAt: T0 + 20 * MIN }], T0),
    ).toBe(PROBE_FAST_MS);
  });

  it('judges the week on its run-out, not its figure', () => {
    expect(probeIntervalMs([{ scope: 'week', utilization: 0.87 }], T0)).toBe(PROBE_SLOW_MS);
    expect(
      probeIntervalMs([{ scope: 'week', utilization: 0.87, runOutAt: T0 + 50 * MIN }], T0),
    ).toBe(PROBE_MEDIUM_MS);
  });
});

const accounts: ClaudeStoredAccount[] = [
  { id: 'a', label: 'Default', credential: { accessToken: 'tok-a' } },
];

function trackerWith(readings: { at: number; session: number; week?: number }[]) {
  let clock = T0;
  const queue = [...readings];
  const tracker = new AccountUsageTracker({
    accounts: () => accounts,
    tokenFor: async () => 'tok-a',
    onChange: () => {},
    probe: async (): Promise<ClaudeUsageResult> => {
      const r = queue.shift()!;
      clock = r.at;
      return {
        kind: 'ok',
        reading: {
          windows: {
            session: { status: 'allowed', utilization: r.session, resetsAt: RESET },
            ...(r.week !== undefined
              ? {
                  week: {
                    status: 'allowed' as const,
                    utilization: r.week,
                    resetsAt: T0 + 3 * 24 * 60 * MIN,
                  },
                }
              : {}),
          },
          blocked: false,
          at: r.at,
        },
      };
    },
    now: () => clock,
    logger: pino({ level: 'silent' }),
  });
  return tracker;
}

describe('AccountUsageTracker forecast', () => {
  it('flags an account burning at 29 Oct pace as nearly out, before it is refused', async () => {
    // 0 -> 95% in 70 min, probed every 10 min.
    const pace = [0, 0.14, 0.27, 0.41, 0.54, 0.68, 0.81, 0.95];
    const tracker = trackerWith(pace.map((u, i) => ({ at: T0 + i * 10 * MIN, session: u })));
    for (let i = 0; i < 4; i++) await tracker.refresh('a', true);
    // 41% at 30 min, ~1.37%/min -> ~41 min to go: not yet.
    expect(tracker.nearlyOut('a')).toBe(false);
    for (let i = 4; i < 6; i++) await tracker.refresh('a', true);
    // 68% -> ~22 min to go: still not.
    expect(tracker.nearlyOut('a')).toBe(false);
    await tracker.refresh('a', true);
    // 81% at 60 min -> ~12 min to go: not under 10.
    expect(tracker.nearlyOut('a')).toBe(false);
    await tracker.refresh('a', true);
    // 95% -> ~2 min to go: move turns off.
    expect(tracker.nearlyOut('a')).toBe(true);
    expect(tracker.runOutAt('a').session).toBeGreaterThan(T0 + 70 * MIN);
  });

  it('forecasts the week as well as the session', async () => {
    const tracker = trackerWith([
      { at: T0, session: 0.1, week: 0.8 },
      { at: T0 + 30 * MIN, session: 0.1, week: 0.9 },
    ]);
    await tracker.refresh('a', true);
    await tracker.refresh('a', true);
    // 10% in 30 min -> 8% more in 24 min.
    const at = tracker.runOutAt('a').week!;
    expect((at - (T0 + 30 * MIN)) / MIN).toBeCloseTo(24, 0);
    expect(tracker.runOutAt('a').session).toBeUndefined();
    expect(tracker.nearlyOut('a')).toBe(false);
  });
});

describe('AccountRotation with a nearly-out account', () => {
  const held = [
    { id: 'work', connected: true },
    { id: 'home', connected: true },
  ];
  const nearlyOut = (id: string) => id === 'work';

  it('sends a new turn to the account that is not about to run out', () => {
    expect(new AccountRotation().startTurn(held, { nearlyOut })).toBe('home');
  });

  it('still uses the nearly-out account when it is the only one', () => {
    expect(new AccountRotation().startTurn([held[0]!], { nearlyOut })).toBe('work');
    const r = new AccountRotation();
    r.markExhausted('home', 'spent');
    expect(r.startTurn(held, { nearlyOut })).toBe('work');
    expect(r.usableAccount(held, { nearlyOut })).toBe('work');
  });

  it('keeps a chat on its own account unless auto-resume lets it move', () => {
    const r = new AccountRotation();
    expect(r.startTurn(held, { nearlyOut, preferred: 'work' })).toBe('work');
    expect(r.startTurn(held, { nearlyOut, preferred: 'work', resumeOnAnyAccount: true })).toBe(
      'home',
    );
  });

  it('moves a chat back to its own account once it is no longer nearly out', () => {
    const r = new AccountRotation();
    const route = { preferred: 'work', resumeOnAnyAccount: true };
    expect(r.startTurn(held, { ...route, nearlyOut })).toBe('home');
    expect(r.startTurn(held, { ...route, nearlyOut: () => false })).toBe('work');
  });

  it('exposes the ten minute threshold', () => {
    expect(NEARLY_OUT_MS).toBe(10 * MIN);
  });
});

describe('adaptive probing', () => {
  it('probes a calm account every 10 minutes and one near its limit every minute', async () => {
    vi.useFakeTimers();
    try {
      let probes = 0;
      let util = 0.2;
      const tracker = new AccountUsageTracker({
        accounts: () => accounts,
        tokenFor: async () => 'tok-a',
        onChange: () => {},
        probe: async (): Promise<ClaudeUsageResult> => {
          probes++;
          return {
            kind: 'ok',
            reading: {
              windows: {
                session: { status: 'allowed', utilization: util, resetsAt: Date.now() + 3_600_000 },
              },
              blocked: false,
              at: Date.now(),
            },
          };
        },
        logger: pino({ level: 'silent' }),
      });
      tracker.start();
      await vi.advanceTimersByTimeAsync(9 * MIN);
      expect(probes).toBe(1);
      await vi.advanceTimersByTimeAsync(2 * MIN);
      expect(probes).toBe(2);
      util = 0.93;
      await vi.advanceTimersByTimeAsync(10 * MIN);
      const afterHigh = probes;
      await vi.advanceTimersByTimeAsync(5 * MIN);
      expect(probes - afterHigh).toBeGreaterThanOrEqual(5);
      tracker.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
