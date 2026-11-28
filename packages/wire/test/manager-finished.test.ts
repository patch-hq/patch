import { describe, expect, it } from 'vitest';
import { finishedStatusLine } from '../src/manager-finished.js';

describe('finishedStatusLine', () => {
  const now = new Date(2026, 10, 28, 15, 0).getTime();
  it('says what is waiting, what is sending and when the last delivery went', () => {
    expect(finishedStatusLine({ waiting: 0, sending: 0, lastSent: null }, now)).toBe(
      'Nothing waiting',
    );
    expect(
      finishedStatusLine(
        {
          waiting: 2,
          sending: 1,
          lastSent: { at: new Date(2026, 10, 28, 14, 30).getTime(), chats: 3 },
        },
        now,
      ),
    ).toBe('2 waiting · 1 sending · last sent 14:30');
    expect(
      finishedStatusLine(
        {
          waiting: 0,
          sending: 0,
          lastSent: { at: new Date(2026, 10, 3, 9, 12).getTime(), chats: 1 },
        },
        now,
      ),
    ).toMatch(/^Nothing waiting · last sent (3 Nov|Nov 3) 09:12$/);
  });
  it('names why waiting chats are held', () => {
    expect(
      finishedStatusLine(
        {
          waiting: 1,
          sending: 0,
          lastSent: null,
          held: 'Manager host Box needs updating for finished chats',
        },
        now,
      ),
    ).toBe('1 waiting · Manager host Box needs updating for finished chats');
  });
});
