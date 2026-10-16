import { describe, it, expect, vi } from 'vitest';
import { agoLabel } from '../routes/settings/hostWrite';

describe('agoLabel (host heartbeat)', () => {
  it('picks the unit from the rounded count, never "60m ago" or "24h ago"', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000_000);
    try {
      expect(agoLabel(null)).toBe('never');
      expect(agoLabel(10_000_000_000 - 4_000)).toBe('4s ago');
      expect(agoLabel(10_000_000_000 - 3_570_000)).toBe('1h ago');
      expect(agoLabel(10_000_000_000 - 86_370_000)).toBe('1d ago');
    } finally {
      vi.useRealTimers();
    }
  });
});
