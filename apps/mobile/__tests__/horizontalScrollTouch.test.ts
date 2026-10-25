import { describe, it, expect } from 'vitest';
import {
  horizontalScrollTouchActive,
  setHorizontalScrollTouch,
} from '../src/lib/horizontalScrollTouch';

describe('horizontalScrollTouch', () => {
  it('is off until a table touch sets it, and off again on release', () => {
    expect(horizontalScrollTouchActive()).toBe(false);
    setHorizontalScrollTouch(true);
    expect(horizontalScrollTouchActive()).toBe(true);
    setHorizontalScrollTouch(false);
    expect(horizontalScrollTouchActive()).toBe(false);
  });
});
