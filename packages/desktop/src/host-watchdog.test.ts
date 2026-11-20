import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { watchHost } from './host-watchdog';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('watchHost', () => {
  it('restarts only after consecutive misses, then waits out the grace period', async () => {
    let restarts = 0;
    const events: boolean[] = [];
    const stop = watchHost({
      answers: async () => false,
      restart: async () => void restarts++,
      onRestart: (ok) => events.push(ok),
      intervalMs: 5,
      strikes: 3,
      graceMs: 10_000,
    });
    await sleep(120);
    stop();
    assert.equal(restarts, 1);
    assert.deepEqual(events, [true]);
  });
  it('an answer resets the count', async () => {
    let n = 0;
    let restarts = 0;
    const stop = watchHost({
      answers: async () => ++n % 3 === 0,
      restart: async () => void restarts++,
      onRestart: () => {},
      intervalMs: 5,
      strikes: 3,
    });
    await sleep(100);
    stop();
    assert.equal(restarts, 0);
  });
  it('reports a restart that failed, e.g. a host turned off', async () => {
    const events: Array<[boolean, string]> = [];
    const stop = watchHost({
      answers: async () => false,
      restart: async () => {
        throw new Error('Could not find service');
      },
      onRestart: (ok, d) => events.push([ok, d]),
      intervalMs: 5,
      strikes: 2,
      graceMs: 10_000,
    });
    await sleep(80);
    stop();
    assert.deepEqual(events, [[false, 'Could not find service']]);
  });
});
