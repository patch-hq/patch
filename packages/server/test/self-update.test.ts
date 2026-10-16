// The server installing the release its channel mirrored (src/self-update.ts).
// systemd is replaced by a `launch` that records what it was asked to run; what
// is under test is when an install starts, what it runs, and what is said when
// it cannot.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RETRY_AFTER_MS, createSelfUpdater, isNewer, planSelfUpdate } from '../src/self-update.js';

describe('isNewer', () => {
  it('compares releases numerically, part by part', () => {
    expect(isNewer('1.1.4', '1.0.2576')).toBe(true);
    expect(isNewer('1.0.10', '1.0.9')).toBe(true);
    expect(isNewer('1.0.9', '1.0.10')).toBe(false);
    expect(isNewer('1.1.4', '1.1.4')).toBe(false);
  });
  it('never calls something it cannot read newer', () => {
    expect(isNewer('dev', '1.0.0')).toBe(false);
    expect(isNewer('1.1.4', 'dev')).toBe(false);
  });
});

describe('planSelfUpdate', () => {
  const base = { running: '1.1.4', tarballPresent: true, userUnit: true };
  it('does nothing when nothing newer is mirrored', () => {
    expect(planSelfUpdate({ ...base, mirrored: null })).toEqual({ kind: 'current' });
    expect(planSelfUpdate({ ...base, mirrored: '1.1.4' })).toEqual({ kind: 'current' });
    expect(planSelfUpdate({ ...base, mirrored: '1.1.3' })).toEqual({ kind: 'current' });
  });
  it('installs a newer release when it runs as a user unit', () => {
    expect(planSelfUpdate({ ...base, mirrored: '1.1.5' })).toEqual({
      kind: 'install',
      to: '1.1.5',
    });
  });
  it('says why when it cannot install it itself', () => {
    expect(planSelfUpdate({ ...base, mirrored: '1.1.5', userUnit: false }).kind).toBe('manual');
    expect(planSelfUpdate({ ...base, mirrored: '1.1.5', tarballPresent: false }).kind).toBe(
      'manual',
    );
  });
});

describe('createSelfUpdater', () => {
  let home: string;
  let downloads: string;
  const env = { ...process.env };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'patch-self-update-'));
    downloads = join(home, 'downloads');
    // A user unit, as the installer writes it, and a systemd invocation.
    mkdirSync(join(home, 'config', 'systemd', 'user'), { recursive: true });
    writeFileSync(join(home, 'config', 'systemd', 'user', 'patch-server.service'), '');
    process.env.XDG_CONFIG_HOME = join(home, 'config');
    process.env.INVOCATION_ID = 'test';
  });
  afterEach(() => {
    process.env = { ...env };
    rmSync(home, { recursive: true, force: true });
  });

  /** A mirrored release `version`, its server tarball holding an installer. */
  function mirror(version: string) {
    const src = join(home, 'src', `patch-server-${version}`);
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'install'), '#!/bin/sh\n');
    mkdirSync(join(downloads, 'server-release'), { recursive: true });
    execFileSync('tar', [
      '-czf',
      join(downloads, 'server-release', 'patch-server.tar.gz'),
      '-C',
      join(home, 'src'),
      `patch-server-${version}`,
    ]);
    writeFileSync(
      join(downloads, 'release-mirror.json'),
      JSON.stringify({ tag: `dev-${version}`, version, mirroredAt: '2026-10-16T00:00:00Z' }),
    );
  }

  function updater(over: { now?: () => number } = {}) {
    const launches: { installer: string; home: string; unit: string }[] = [];
    const logs: string[] = [];
    const check = createSelfUpdater({
      home,
      downloadsDir: downloads,
      running: '1.1.4',
      log: (m) => logs.push(m),
      launch: (installer, h, unit) => launches.push({ installer, home: h, unit }),
      ...over,
    });
    return { check, launches, logs };
  }

  it('runs the newer release’s own installer against this home, and says where to watch', () => {
    mirror('1.1.5');
    const { check, launches, logs } = updater();
    check();
    expect(launches).toHaveLength(1);
    expect(launches[0]!.installer).toBe(join(home, 'updates', 'patch-server-1.1.5', 'install'));
    expect(launches[0]!.home).toBe(home);
    expect(logs[0]).toContain(`journalctl --user -u ${launches[0]!.unit}`);
  });

  it('leaves a current server alone', () => {
    mirror('1.1.4');
    const { check, launches, logs } = updater();
    check();
    expect(launches).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  it('tries the same release again only after a pause', () => {
    mirror('1.1.5');
    let t = 1_000;
    const { check, launches } = updater({ now: () => t });
    check();
    check();
    expect(launches).toHaveLength(1);
    t += RETRY_AFTER_MS;
    check();
    expect(launches).toHaveLength(2);
  });

  it('a server that is not a user unit is told what to run, once', () => {
    delete process.env.INVOCATION_ID;
    mirror('1.1.5');
    const { check, launches, logs } = updater();
    check();
    check();
    expect(launches).toHaveLength(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/1\.1\.5 is mirrored but not installed.*install --home/);
  });

  it('a launch that fails is logged loudly, not thrown', () => {
    mirror('1.1.5');
    const logs: string[] = [];
    const check = createSelfUpdater({
      home,
      downloadsDir: downloads,
      running: '1.1.4',
      log: (m) => logs.push(m),
      launch: () => {
        throw new Error('systemd-run: not found');
      },
    });
    expect(() => check()).not.toThrow();
    expect(logs[0]).toMatch(/self-update FAILED.*systemd-run: not found/);
  });
});
