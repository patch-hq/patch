import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireHomeLock } from '../src/homeLock.js';

describe('acquireHomeLock', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'home-lock-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('refuses a second host on the same home while the first is alive, whatever port it uses', () => {
    const first = acquireHomeLock(home);
    expect(() => acquireHomeLock(home)).toThrow(/already running/);
    first.release();
  });

  it('can be taken again once released', () => {
    acquireHomeLock(home).release();
    expect(() => acquireHomeLock(home).release()).not.toThrow();
    expect(existsSync(join(home, 'daemon.lock'))).toBe(false);
  });

  it('takes over a lock left by a dead process', () => {
    writeFileSync(join(home, 'daemon.lock'), '2147483646\n');
    expect(() => acquireHomeLock(home).release()).not.toThrow();
  });

  it.each([
    ['empty', ''],
    ['garbage', 'garbage'],
  ])('replaces an %s lock left by a crash, with a log line', (_n, body) => {
    const lock = join(home, 'daemon.lock');
    writeFileSync(lock, body);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const logs: string[] = [];
    const held = acquireHomeLock(home, (m) => logs.push(m));
    expect(logs.join()).toMatch(/stale/);
    expect(readFileSync(lock, 'utf8').trim()).toBe(String(process.pid));
    held.release();
  });

  it('does not steal an empty lock that was only just created', () => {
    writeFileSync(join(home, 'daemon.lock'), '');
    expect(() => acquireHomeLock(home)).toThrow(/just created/);
  });
});
