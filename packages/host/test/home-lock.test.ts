import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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

  it('fails loudly on a lock file it cannot understand', () => {
    writeFileSync(join(home, 'daemon.lock'), 'garbage');
    expect(() => acquireHomeLock(home)).toThrow(/unreadable/);
  });
});
