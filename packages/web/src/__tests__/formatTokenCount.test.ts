import { describe, it, expect } from 'vitest';
import { formatTokenCount } from '../components/GoalBanner';

describe('formatTokenCount', () => {
  it('humanises counts', () => {
    expect(formatTokenCount(842)).toBe('842');
    expect(formatTokenCount(8_200)).toBe('8.2k');
    expect(formatTokenCount(1_400_000)).toBe('1.4M');
  });

  it('rolls 999,950+ over to M instead of reading 1000k', () => {
    expect(formatTokenCount(999_949)).toBe('999.9k');
    expect(formatTokenCount(999_950)).toBe('1M');
    expect(formatTokenCount(999_999)).toBe('1M');
  });
});
