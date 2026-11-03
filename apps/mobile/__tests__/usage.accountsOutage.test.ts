import { describe, it, expect } from 'vitest';
import { accountsOutage } from '../src/lib/usage';

const now = 1_000_000;
const spent = (resetsAt: number) => ({
  session: { status: 'rejected' as const, utilization: 1, resetsAt },
});
const fine = { session: { status: 'allowed' as const, utilization: 0.1 } };

describe('accountsOutage', () => {
  it('is null with no connected account', () => {
    expect(accountsOutage([], now)).toBeNull();
    expect(accountsOutage([{ connected: false, usage: spent(now + 1) }], now)).toBeNull();
  });
  it('is null when any account has no reading or still has usage', () => {
    expect(accountsOutage([{ connected: true }], now)).toBeNull();
    expect(
      accountsOutage(
        [
          { connected: true, usage: spent(now + 5) },
          { connected: true, usage: fine },
        ],
        now,
      ),
    ).toBeNull();
  });
  it('reports the soonest reset when every account is spent', () => {
    expect(
      accountsOutage(
        [
          { connected: true, usage: spent(now + 500) },
          { connected: true, usage: spent(now + 100) },
        ],
        now,
      ),
    ).toEqual({ resetsAt: now + 100 });
  });
  it('is no longer out once the reset has passed', () => {
    expect(accountsOutage([{ connected: true, usage: spent(now - 1) }], now)).toBeNull();
  });
});
