import { describe, it, expect } from 'vitest';
import { liftForUnreadNotification } from '../src/lib/chatBadge';

describe('liftForUnreadNotification', () => {
  it('lifts only the quiet states to done', () => {
    for (const b of ['read', 'background', 'monitoring'] as const) {
      expect(liftForUnreadNotification(b, true)).toBe('done');
      expect(liftForUnreadNotification(b, false)).toBe(b);
    }
    for (const b of ['working', 'permission', 'errored', 'done'] as const) {
      expect(liftForUnreadNotification(b, true)).toBe(b);
    }
  });
});
