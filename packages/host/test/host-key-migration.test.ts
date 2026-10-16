import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readDaemonKey, writeDaemonKey } from '../src/registration.js';

// Rename phase 1: a pre-rename daemon.key is moved to host.key on first read.
describe('host.key migration', () => {
  const dirs: string[] = [];
  const mk = () => {
    const d = mkdtempSync(join(tmpdir(), 'patch-hostkey-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('reads an old daemon.key and renames it to host.key', () => {
    const home = mk();
    writeFileSync(join(home, 'daemon.key'), 'old-key\n');
    expect(readDaemonKey(home)).toBe('old-key');
    expect(existsSync(join(home, 'daemon.key'))).toBe(false);
    expect(readFileSync(join(home, 'host.key'), 'utf8')).toBe('old-key\n');
  });

  it('writes host.key, and prefers an existing host.key over daemon.key', () => {
    const home = mk();
    writeDaemonKey(home, 'new-key');
    expect(readFileSync(join(home, 'host.key'), 'utf8')).toBe('new-key');
    expect(existsSync(join(home, 'daemon.key'))).toBe(false);
  });

  it('returns undefined when neither file exists', () => {
    expect(readDaemonKey(mk())).toBeUndefined();
  });
});
