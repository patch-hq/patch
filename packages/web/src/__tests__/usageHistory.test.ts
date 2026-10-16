import { describe, it, expect } from 'vitest';
import { buildBurndown, periodWindow } from '../lib/usageHistory.js';

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
