import { describe, it, expect } from 'vitest';
import { smoothLevel } from '../lib/smoothLevel.js';

describe('smoothLevel', () => {
  it('rises faster than it falls', () => {
    const up = smoothLevel(0, 1);
    const down = 1 - smoothLevel(1, 0);
    expect(up).toBeGreaterThan(down);
  });
  it('stays within 0..1', () => {
    expect(smoothLevel(0.5, 7)).toBeLessThanOrEqual(1);
    expect(smoothLevel(0.5, -3)).toBeGreaterThanOrEqual(0);
  });
});
