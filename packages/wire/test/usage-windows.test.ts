// How one limit window should be drawn — the single rule the web and mobile
// settings rows share, so a warning cannot show on one surface and not the other.

import { describe, it, expect } from 'vitest';
import {
  rateLimitWindowState,
  rateLimitWindowsBlocked,
  refusingRateLimitScope,
} from '../src/usageWindows.js';

describe('rateLimitWindowState', () => {
  it('reads a rejected spendable pool as blocked', () => {
    expect(rateLimitWindowState('session', { status: 'rejected', utilization: 1 })).toBe('blocked');
    expect(rateLimitWindowState('week', { status: 'rejected' })).toBe('blocked');
  });

  it('reads a rejected overage as off — the add-on was never bought', () => {
    expect(rateLimitWindowState('overage', { status: 'rejected' })).toBe('off');
  });

  it('warns at 80% used', () => {
    expect(rateLimitWindowState('session', { status: 'allowed', utilization: 0.8 })).toBe('warn');
    expect(rateLimitWindowState('session', { status: 'allowed', utilization: 0.79 })).toBe('ok');
  });

  it('warns whenever Anthropic says allowed_warning, whatever the figure', () => {
    expect(rateLimitWindowState('week', { status: 'allowed_warning' })).toBe('warn');
    expect(rateLimitWindowState('week', { status: 'allowed_warning', utilization: 0.3 })).toBe(
      'warn',
    );
    expect(rateLimitWindowState('overage', { status: 'allowed_warning' })).toBe('warn');
  });
});

describe('a rejected window whose reset has passed', () => {
  const NOW = 1_800_000_000_000;

  it('is no longer refusing — the reading is older than the reset', () => {
    const windows = { session: { status: 'rejected' as const, resetsAt: NOW - 1 } };
    expect(refusingRateLimitScope(windows, NOW)).toBeUndefined();
    expect(rateLimitWindowsBlocked(windows, NOW)).toBe(false);
  });

  it('still refuses before the reset, and when no reset was stated', () => {
    expect(
      refusingRateLimitScope({ session: { status: 'rejected', resetsAt: NOW + 1 } }, NOW),
    ).toBe('session');
    expect(refusingRateLimitScope({ week: { status: 'rejected' } }, NOW)).toBe('week');
  });

  it('blames the pool that is still out when the other has reset', () => {
    const windows = {
      session: { status: 'rejected' as const, resetsAt: NOW - 5 },
      week: { status: 'rejected' as const, resetsAt: NOW + 5 },
    };
    expect(refusingRateLimitScope(windows, NOW)).toBe('week');
  });

  it('is drawn as ok-or-unknown, not blocked', () => {
    expect(
      rateLimitWindowState('session', { status: 'rejected', resetsAt: NOW - 1 }, NOW),
    ).not.toBe('blocked');
  });
});
