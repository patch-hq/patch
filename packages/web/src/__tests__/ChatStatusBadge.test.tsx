import { describe, it, expect } from 'vitest';
import { liftForUnreadNotification } from '../components/ChatStatusBadge.js';
import type { DisplayBadge } from '../stores/types.js';

describe('liftForUnreadNotification', () => {
  it.each<DisplayBadge>(['read', 'background', 'monitoring'])('lifts a quiet %s chat', (b) => {
    expect(liftForUnreadNotification(b, true)).toBe('done');
  });

  it.each<DisplayBadge>(['working', 'permission', 'errored', 'done'])('never changes %s', (b) => {
    expect(liftForUnreadNotification(b, true)).toBe(b);
  });

  it.each<DisplayBadge>(['read', 'background', 'monitoring', 'working'])(
    'leaves %s alone with nothing unread',
    (b) => {
      expect(liftForUnreadNotification(b, false)).toBe(b);
    },
  );
});
