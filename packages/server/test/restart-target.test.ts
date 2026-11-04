import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRestartTarget } from '../src/start.js';

describe('readRestartTarget', () => {
  const home = mkdtempSync(join(tmpdir(), 'patch-rt-'));
  mkdirSync(join(home, 'current'));
  const info = (v: string): void =>
    writeFileSync(join(home, 'current', 'build-info.json'), JSON.stringify({ version: v }));

  it('is the version current points at when it differs from the running one', () => {
    info('1.2.4');
    expect(readRestartTarget(home, '1.2.3')).toBe('1.2.4');
  });
  it('is null for a restart into the same release', () => {
    info('1.2.3');
    expect(readRestartTarget(home, '1.2.3')).toBeNull();
  });
  it('is null when there is no install home or no release', () => {
    expect(readRestartTarget(undefined, '1.2.3')).toBeNull();
    expect(readRestartTarget(join(home, 'nope'), '1.2.3')).toBeNull();
  });
  it('throws on a build-info.json with no version rather than guessing', () => {
    writeFileSync(join(home, 'current', 'build-info.json'), '{}');
    expect(() => readRestartTarget(home, '1.2.3')).toThrow(/no version/);
    rmSync(home, { recursive: true, force: true });
  });
});
