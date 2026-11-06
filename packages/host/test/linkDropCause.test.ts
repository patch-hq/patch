import { describe, it, expect } from 'vitest';
import { CLOSE_SERVER_RESTARTING } from '@patch/wire';
import { classifyDrop, createSleepDetector, describeDrop } from '../src/linkDropCause.js';

function clocks() {
  let wall = 1_000_000;
  let mono = 0;
  return {
    wallNow: () => wall,
    monoNow: () => mono,
    run: (ms: number) => {
      wall += ms;
      mono += ms;
    },
    sleep: (ms: number) => {
      wall += ms;
    },
  };
}

describe('sleep detector', () => {
  it('ignores ordinary elapsed time', () => {
    const c = clocks();
    const d = createSleepDetector(c);
    c.run(5_000);
    d.sample();
    expect(d.lastSleep()).toBeUndefined();
  });
  it('records a wall-clock jump the monotonic clock did not see', () => {
    const c = clocks();
    const d = createSleepDetector(c);
    c.run(5_000);
    c.sleep(240_000);
    d.sample();
    expect(d.lastSleep()?.ms).toBe(240_000);
  });
});

describe('classifyDrop', () => {
  it('calls a planned server close a server restart', () => {
    const d = createSleepDetector(clocks());
    expect(classifyDrop(CLOSE_SERVER_RESTARTING, d).cause).toBe('server-restart');
    expect(classifyDrop(1001, d).cause).toBe('server-restart');
  });
  it('attributes a drop right after a sleep to the sleep', () => {
    const c = clocks();
    const d = createSleepDetector(c);
    c.sleep(960_000);
    const drop = classifyDrop(1006, d, c.wallNow());
    expect(drop).toMatchObject({ cause: 'sleep', sleptSeconds: 960, code: 1006 });
    expect(describeDrop(drop)).toBe('host slept for 960s');
  });
  it('leaves a drop with no sleep unexplained', () => {
    const c = clocks();
    const d = createSleepDetector(c);
    c.run(30_000);
    expect(classifyDrop(1006, d, c.wallNow()).cause).toBe('unexplained');
  });
  it('does not blame a sleep that ended long before the drop', () => {
    const c = clocks();
    const d = createSleepDetector(c);
    c.sleep(60_000);
    d.sample();
    c.run(600_000);
    expect(classifyDrop(1006, d, c.wallNow()).cause).toBe('unexplained');
  });
});
