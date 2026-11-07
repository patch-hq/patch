import { describe, it, expect, beforeEach } from 'vitest';
import { pcmLevel, useMicLevelStore } from '../src/stores/micLevelStore';

describe('micLevelStore', () => {
  beforeEach(() => useMicLevelStore.getState().reset());

  it('silence is 0 and a loud frame is high, capped at 1', () => {
    expect(pcmLevel(new Int16Array(100))).toBe(0);
    expect(pcmLevel(new Int16Array(100).fill(32767))).toBe(1);
    expect(pcmLevel(new Int16Array(0))).toBe(0);
  });

  it('rises faster than it falls', () => {
    const s = useMicLevelStore.getState();
    s.push(new Int16Array(100).fill(16000));
    const up = useMicLevelStore.getState().level;
    s.push(new Int16Array(100));
    const down = up - useMicLevelStore.getState().level;
    expect(up).toBeGreaterThan(down);
    expect(useMicLevelStore.getState().level).toBeGreaterThan(0);
  });
});
