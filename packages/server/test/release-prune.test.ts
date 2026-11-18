import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneDownloads } from '../src/release-prune.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patch-prune-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const touch = (n: string, body = 'x') => writeFileSync(join(dir, n), body);

describe('pruneDownloads', () => {
  it('keeps the newest versions (numerically) and what manifests name, removes the rest', () => {
    for (const v of ['1.1.9', '1.1.10', '1.1.11', '1.1.12', '1.1.13']) {
      touch(`patch-${v}.apk`);
      touch(`Patch-${v}-arm64-mac.zip`);
      touch(`patch-host-${v}-linux-x64.tar.gz`);
      touch(`patch-host-${v}-linux-x64.tar.gz.sig`);
    }
    touch('android-latest.json', JSON.stringify({ file: 'patch-1.1.9.apk' }));
    touch('latest-mac.yml', 'path: Patch-1.1.9-arm64-mac.zip');
    touch('install.sh');
    touch('release-mirror.json');
    mkdirSync(join(dir, 'server-release'));
    touch('server-release/patch-server.tar.gz');

    const logs: string[] = [];
    pruneDownloads(dir, (m) => logs.push(m));

    const left = readdirSync(dir);
    expect(left).toContain('patch-1.1.9.apk');
    expect(left).toContain('Patch-1.1.9-arm64-mac.zip');
    expect(left).not.toContain('patch-host-1.1.9-linux-x64.tar.gz');
    expect(left).not.toContain('patch-1.1.10.apk');
    for (const v of ['1.1.11', '1.1.12', '1.1.13']) {
      expect(left).toContain(`patch-host-${v}-linux-x64.tar.gz.sig`);
    }
    expect(left).toEqual(
      expect.arrayContaining(['install.sh', 'release-mirror.json', 'server-release']),
    );
    expect(existsSync(join(dir, 'server-release', 'patch-server.tar.gz'))).toBe(true);
    expect(logs.join()).toMatch(/removed/);
  });

  it('does nothing when there are few versions', () => {
    touch('patch-1.0.1.apk');
    expect(pruneDownloads(dir)).toEqual([]);
  });
});
