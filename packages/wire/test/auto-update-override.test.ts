import { describe, expect, it } from 'vitest';
import { activeAutoUpdateOverride, effectiveAutoUpdate } from '../src/index.js';

describe('per-host auto-update override', () => {
  it('falls back to the shared default with no override', () => {
    expect(effectiveAutoUpdate(true, undefined, 1000)).toBe(true);
    expect(effectiveAutoUpdate(false, null, 1000)).toBe(false);
  });
  it('lets an override beat the shared default either way', () => {
    expect(effectiveAutoUpdate(true, { enabled: false }, 1000)).toBe(false);
    expect(effectiveAutoUpdate(false, { enabled: true }, 1000)).toBe(true);
  });
  it('turns itself back to the default once `until` lapses', () => {
    const o = { enabled: false, until: 2000 };
    expect(effectiveAutoUpdate(true, o, 1999)).toBe(false);
    expect(effectiveAutoUpdate(true, o, 2000)).toBe(true);
    expect(activeAutoUpdateOverride(o, 2000)).toBeUndefined();
  });
});
