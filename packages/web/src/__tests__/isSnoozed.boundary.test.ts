// The client decides "snoozed" from its own clock (`snoozedUntil > now`), so a
// chat reappears on a surface the instant that surface's clock passes the wake
// time. These pin the boundary and the one-clock-per-surface consequence.

import { describe, it, expect } from 'vitest';
import { isSnoozed } from '../stores/types.js';

const T0 = 1_700_000_000_000;

describe('isSnoozed', () => {
  it('is snoozed 1ms before the wake time and not at it', () => {
    expect(isSnoozed({ snoozedUntil: T0 }, T0 - 1)).toBe(true);
    expect(isSnoozed({ snoozedUntil: T0 }, T0)).toBe(false);
  });
  it('null is never snoozed', () => {
    expect(isSnoozed({ snoozedUntil: null }, T0)).toBe(false);
  });
  it('the until-complete sentinel is snoozed at any realistic time', () => {
    expect(isSnoozed({ snoozedUntil: 8_640_000_000_000_000 }, T0 + 10 * 365 * 86_400_000)).toBe(
      true,
    );
  });
  it('a surface whose clock runs ahead shows the chat early by exactly the skew', () => {
    const wake = T0 + 10 * 60_000;
    const skew = 3 * 60_000;
    const deviceNow = (serverNow: number) => serverNow + skew;
    expect(isSnoozed({ snoozedUntil: wake }, deviceNow(wake - skew - 1))).toBe(true);
    expect(isSnoozed({ snoozedUntil: wake }, deviceNow(wake - skew))).toBe(false);
  });
});
