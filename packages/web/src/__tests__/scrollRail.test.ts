import { describe, it, expect } from 'vitest';
import { railMarkers, nextFarState, isFar, RAIL_MAX_MARKERS } from '../lib/scrollRail.js';

const turn = (seq: number, at: number) => ({
  seq,
  kind: 'message',
  role: 'user',
  messageAt: at,
});
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1, 12);

describe('railMarkers', () => {
  it('marks nothing for a chat with fewer than two timed turns', () => {
    expect(railMarkers([])).toEqual([]);
    expect(railMarkers([turn(1, T0)])).toEqual([]);
    expect(railMarkers([{ seq: 1, kind: 'message', role: 'assistant', messageAt: T0 }])).toEqual(
      [],
    );
  });

  it('marks one point per day, labelled by date, when the chat spans days', () => {
    const m = railMarkers([
      turn(1, T0),
      turn(2, T0 + 1000),
      turn(3, T0 + DAY),
      turn(4, T0 + 2 * DAY),
    ]);
    expect(m.map((x) => x.seq)).toEqual([1, 3, 4]);
    expect(m[0]?.label).toMatch(/1 Oct/);
  });

  it('caps the markers and keeps the first and last day', () => {
    const turns = Array.from({ length: 60 }, (_v, i) => turn(i, T0 + i * DAY));
    const m = railMarkers(turns);
    expect(m).toHaveLength(RAIL_MAX_MARKERS);
    expect(m[0]?.seq).toBe(0);
    expect(m[m.length - 1]?.seq).toBe(59);
  });

  it('labels by time when everything is on one day', () => {
    const m = railMarkers([turn(1, T0), turn(2, T0 + 3_600_000)]);
    expect(m.map((x) => x.seq)).toEqual([1, 2]);
    expect(m[0]?.label).toMatch(/^\d\d:\d\d$/);
  });
});

describe('far-scroll detection', () => {
  const vp = 700;
  it('needs several screens of upward scrolling in one burst', () => {
    let s = { up: 0, lastAt: 0 };
    s = nextFarState(s, -400, 100);
    expect(isFar(s, vp)).toBe(false);
    for (let t = 200; t < 1200; t += 100) s = nextFarState(s, -400, t);
    expect(isFar(s, vp)).toBe(true);
  });
  it('a pause or a turn downward starts again', () => {
    let s = { up: 5000, lastAt: 0 };
    expect(isFar(nextFarState(s, -10, 10_000), vp)).toBe(false);
    s = nextFarState({ up: 5000, lastAt: 0 }, 50, 100);
    expect(s.up).toBe(0);
  });
});
