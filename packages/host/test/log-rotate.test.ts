import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotateLog } from '../src/logRotate.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'patch-rot-'));
  dirs.push(d);
  return d;
};

it('leaves a log under the cap alone', () => {
  const p = join(dir(), 'daemon.log');
  writeFileSync(p, 'small');
  expect(rotateLog(p, 100)).toBe(false);
  expect(readFileSync(p, 'utf8')).toBe('small');
  expect(existsSync(p + '.1')).toBe(false);
});

it('moves an over-cap log to .1 and empties it, replacing an older .1', () => {
  const p = join(dir(), 'daemon.log');
  writeFileSync(p + '.1', 'older');
  writeFileSync(p, 'x'.repeat(200));
  expect(rotateLog(p, 100)).toBe(true);
  expect(statSync(p).size).toBe(0);
  expect(readFileSync(p + '.1', 'utf8')).toBe('x'.repeat(200));
});

it('does nothing when there is no log', () => {
  expect(rotateLog(join(dir(), 'none.log'))).toBe(false);
});
