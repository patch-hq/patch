import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from './wait-for.mjs';

test('returns as soon as the check passes, without sleeping', () => {
  let slept = 0;
  waitFor('x', () => true, { sleep: () => slept++ });
  assert.equal(slept, 0);
});

test('reports progress periodically while waiting, with the current state', () => {
  let calls = 0;
  const lines = [];
  waitFor('host running 9', () => ++calls > 7, {
    intervalSec: 2,
    reportEvery: 3,
    report: (l) => lines.push(l),
    sleep: () => {},
    detail: () => 'host is on 8',
  });
  assert.deepEqual(lines, [
    'still waiting for host running 9 (6s of 120s) — host is on 8',
    'still waiting for host running 9 (12s of 120s) — host is on 8',
  ]);
});

test('says nothing when reporting is off', () => {
  const lines = [];
  let calls = 0;
  waitFor('x', () => ++calls > 5, { report: (l) => lines.push(l), sleep: () => {} });
  assert.deepEqual(lines, []);
});

test('times out loudly, naming what it waited for', () => {
  assert.throws(
    () => waitFor('the host', () => false, { tries: 3, sleep: () => {} }),
    /timed out waiting for: the host/,
  );
});
