// Staging a release ahead of the server's restart (spec/11 § Updates in lockstep):
// download and verify now, install later, from disk, with the server gone.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyUpdate, pruneStaged, stageUpdate, stagedBuild } from '../src/selfUpdate.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

function signed(digestHex: string): { sig: string; publicKeyB64Url: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const sig = cryptoSign(null, Buffer.from(digestHex, 'hex'), privateKey).toString('base64url');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { sig, publicKeyB64Url: Buffer.from(raw).toString('base64url') };
}

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patch-stage-test-'));
  home = join(dir, 'home');
  mkdirSync(home);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function release(version: string, opts: { tamper?: boolean } = {}): typeof fetch {
  const name = `patch-host-${version}-linux-x64`;
  mkdirSync(join(dir, 'build', name), { recursive: true });
  writeFileSync(join(dir, 'build', name, 'install'), '#!/bin/sh\n');
  execFileSync('tar', ['-czf', join(dir, `${name}.tar.gz`), '-C', join(dir, 'build'), name]);
  const bytes = readFileSync(join(dir, `${name}.tar.gz`));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const { sig, publicKeyB64Url } = signed(digest);
  const manifest = {
    version,
    signingPublicKey: publicKeyB64Url,
    artifacts: [
      {
        target: 'linux-x64',
        file: `${name}.tar.gz`,
        sha256: opts.tamper ? 'f'.repeat(64) : digest,
        sig,
      },
    ],
  };
  return (async (url: string) =>
    url.endsWith('.json')
      ? new Response(JSON.stringify(manifest))
      : new Response(bytes)) as unknown as typeof fetch;
}

const base = () => ({
  serverUrl: 'http://s',
  internalToken: 'tok',
  currentVersion: '0.1.0',
  target: 'linux-x64',
  patchHome: home,
});

const serverDown = (async () => {
  throw new Error('ECONNREFUSED');
}) as unknown as typeof fetch;

describe('stageUpdate', () => {
  it('downloads and verifies the build and keeps it without installing', async () => {
    const res = await stageUpdate({ ...base(), version: '0.2.0', fetchImpl: release('0.2.0') });
    expect(res.staged).toBe(true);
    const dir0 = stagedBuild(home, '0.2.0');
    expect(dir0).not.toBeNull();
    expect(existsSync(join(dir0!, 'install'))).toBe(true);
  });

  it('refuses a build whose digest does not match, and keeps nothing', async () => {
    const res = await stageUpdate({
      ...base(),
      version: '0.2.0',
      fetchImpl: release('0.2.0', { tamper: true }),
    });
    expect(res.staged).toBe(false);
    expect(res.message).toMatch(/does not match/);
    expect(stagedBuild(home, '0.2.0')).toBeNull();
  });

  it('refuses when the server publishes a different version than the one asked for', async () => {
    const res = await stageUpdate({ ...base(), version: '0.3.0', fetchImpl: release('0.2.0') });
    expect(res.staged).toBe(false);
    expect(res.message).toMatch(/publishes 0\.2\.0, not 0\.3\.0/);
    expect(stagedBuild(home, '0.3.0')).toBeNull();
  });

  it('drops an older staged build when a newer one is staged', async () => {
    await stageUpdate({ ...base(), version: '0.2.0', fetchImpl: release('0.2.0') });
    await stageUpdate({ ...base(), version: '0.2.1', fetchImpl: release('0.2.1') });
    expect(stagedBuild(home, '0.2.0')).toBeNull();
    expect(stagedBuild(home, '0.2.1')).not.toBeNull();
  });
});

describe('applyUpdate from a staged build', () => {
  it('installs the staged build without contacting the server', async () => {
    await stageUpdate({ ...base(), version: '0.2.0', fetchImpl: release('0.2.0') });
    const runInstaller = vi.fn(async () => {});
    const onInstallStart = vi.fn();
    await applyUpdate({
      ...base(),
      logger,
      stagedVersion: '0.2.0',
      fetchImpl: serverDown,
      runInstaller,
      onInstallStart,
    });
    expect(onInstallStart).toHaveBeenCalledWith('0.2.0');
    expect(runInstaller).toHaveBeenCalledTimes(1);
    expect(runInstaller.mock.calls[0]![0]).toBe(join(stagedBuild(home, '0.2.0')!, 'install'));
  });

  it('says so when nothing is staged for that version, and installs nothing', async () => {
    const runInstaller = vi.fn(async () => {});
    const res = await applyUpdate({
      ...base(),
      logger,
      stagedVersion: '0.2.0',
      fetchImpl: serverDown,
      runInstaller,
    });
    expect(res.applied).toBe(false);
    expect(res.message).toMatch(/no staged build for 0\.2\.0/);
    expect(runInstaller).not.toHaveBeenCalled();
  });
});

describe('pruneStaged', () => {
  it('removes staged builds at or below the running version, keeps newer ones', async () => {
    await stageUpdate({ ...base(), version: '0.2.0', fetchImpl: release('0.2.0') });
    pruneStaged(home, '0.2.0');
    expect(stagedBuild(home, '0.2.0')).toBeNull();
    await stageUpdate({ ...base(), version: '0.2.1', fetchImpl: release('0.2.1') });
    pruneStaged(home, '0.2.0');
    expect(stagedBuild(home, '0.2.1')).not.toBeNull();
  });
});
