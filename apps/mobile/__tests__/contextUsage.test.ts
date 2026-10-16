import { describe, it, expect } from 'vitest';
import { formatTokens, summariseContext } from '../src/lib/contextUsage';

describe('contextUsage', () => {
  it('formats tokens', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(84_400)).toBe('84k');
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(1_500_000)).toBe('1.5M');
    expect(formatTokens(12_000_000)).toBe('12M');
    expect(formatTokens(999_499)).toBe('999k');
    expect(formatTokens(999_500)).toBe('1M');
  });
  it('is null until measured', () => {
    expect(summariseContext(null)).toBeNull();
    expect(summariseContext(undefined)).toBeNull();
  });
  it('tokens without a window read ?, not a fraction of a guess', () => {
    expect(summariseContext({ usedTokens: 5000, at: 1 })).toEqual({
      fraction: 0,
      percent: '?',
      tokens: '5k / ?',
      level: 'unknown',
    });
  });
  it('levels: ok under 70%, warn from 70%, blocked from 90%, capped at 100%', () => {
    const at = (u: number) => summariseContext({ usedTokens: u, windowTokens: 100, at: 1 })!;
    expect(at(69).level).toBe('ok');
    expect(at(70).level).toBe('warn');
    expect(at(90).level).toBe('blocked');
    expect(at(150)).toMatchObject({ fraction: 1, percent: '100%' });
  });
});
