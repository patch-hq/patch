import { describe, it, expect } from 'vitest';
import { buildBurndown, burndownPath, periodWindow, splitAtResets } from '../lib/usageHistory.js';

describe('periodWindow', () => {
  const now = Date.UTC(2026, 9, 14, 12);
  it('names fixed spans back from now', () => {
    expect(periodWindow('day', now)).toEqual({ since: now - 86_400_000, until: now });
    expect(periodWindow('week', now)!.since).toBe(now - 7 * 86_400_000);
    expect(periodWindow('month', now)!.since).toBe(now - 30 * 86_400_000);
  });
  it('custom needs both dates, in order', () => {
    expect(periodWindow('custom', now, { from: '', to: '2026-10-02' })).toBeNull();
    expect(periodWindow('custom', now, { from: '2026-10-05', to: '2026-10-02' })).toBeNull();
    const w = periodWindow('custom', now, { from: '2026-10-01', to: '2026-10-02' })!;
    expect(w.until - w.since).toBeGreaterThan(86_400_000);
  });
  it('custom never reaches past now', () => {
    expect(periodWindow('custom', now, { from: '2026-10-01', to: '2030-01-01' })!.until).toBe(now);
  });
});

describe('buildBurndown', () => {
  it('turns weekly utilisation into percent remaining, one line per account', () => {
    const s = buildBurndown([
      { ts: 2, accountId: 'a', label: 'A', week: 0.4, hostId: 'h' },
      { ts: 1, accountId: 'a', label: 'A', week: 0.1, hostId: 'h' },
      { ts: 1, accountId: 'b', label: 'B', week: 0.75, hostId: 'h' },
      { ts: 3, accountId: 'b', label: 'B', session: 0.5, hostId: 'h' }, // no week reading: skipped
    ]);
    expect(s.map((x) => [x.label, x.points.map((p) => p.remaining)])).toEqual([
      ['A', [90, 60]],
      ['B', [25]],
    ]);
  });
});

describe('splitAtResets', () => {
  it('starts a new run wherever what is left jumps back up', () => {
    const runs = splitAtResets([
      { ts: 1, remaining: 60 },
      { ts: 2, remaining: 50 },
      { ts: 3, remaining: 100 },
      { ts: 4, remaining: 90 },
      { ts: 5, remaining: 91 }, // a wobble, not a reset
    ]);
    expect(runs.map((r) => r.map((p) => p.remaining))).toEqual([
      [60, 50],
      [100, 90, 91],
    ]);
  });
});

describe('burndownPath', () => {
  const x = (ts: number) => ts;
  const y = (pct: number) => 100 - pct;
  it('is one smooth curve within a cycle', () => {
    const d = burndownPath(
      [
        { ts: 0, remaining: 100 },
        { ts: 10, remaining: 80 },
        { ts: 20, remaining: 50 },
      ],
      x,
      y,
    );
    expect(d.startsWith('M0,0')).toBe(true);
    expect(d.match(/ C/g)).toHaveLength(2);
    expect(d).not.toContain(' L');
  });
  it('steps straight up at a reset rather than curving through it', () => {
    const d = burndownPath(
      [
        { ts: 0, remaining: 60 },
        { ts: 10, remaining: 50 },
        { ts: 10, remaining: 100 },
        { ts: 20, remaining: 90 },
      ],
      x,
      y,
    );
    // The reset is a vertical line to the new run's first point, at full.
    expect(d).toContain(' L10,0');
  });
  it('never overshoots a reading', () => {
    // Monotone: a curve between 100 and 90 stays at or below 100.
    const d = burndownPath(
      [
        { ts: 0, remaining: 100 },
        { ts: 10, remaining: 100 },
        { ts: 20, remaining: 60 },
      ],
      x,
      y,
    );
    const ys = [...d.matchAll(/[\d.]+,(-?[\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
  });
});
