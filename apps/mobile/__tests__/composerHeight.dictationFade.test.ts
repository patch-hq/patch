import { describe, it, expect } from 'vitest';
import {
  DICTATION_FADE_BANDS,
  DICTATION_HEIGHT_FRACTION,
  dictationMaxHeight,
} from '../src/lib/composerHeight';

describe('dictation fade', () => {
  it('keeps the dictation box compact', () => {
    expect(DICTATION_HEIGHT_FRACTION).toBeLessThan(0.2);
    expect(dictationMaxHeight(800)).toBe(112);
  });
  it('fades from most hidden at the top to least', () => {
    const b = [...DICTATION_FADE_BANDS];
    expect(b).toEqual([...b].sort((x, y) => y - x));
    expect(b[0]).toBeGreaterThan(0.9);
  });
});
