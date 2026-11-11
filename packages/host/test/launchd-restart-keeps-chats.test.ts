// A host update must restart the host process only. Re-registering the launchd
// job (bootout) or `kickstart -k` takes every running chat's turn runner down
// with it (2026-11-11). The runner side — turns outliving the host — is
// pinned in durable-turn.test.ts; this pins the installer side.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  launchdOps,
  launchdPlist,
  launchdPlistPath,
  SERVICE_LABEL,
  type ServiceDefinition,
} from '../src/installer/service.js';

const calls: string[][] = [];
let loaded = true;

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void,
  ) => {
    calls.push([file, ...args]);
    if (args[0] === 'bootout' && args[1]?.endsWith(`/${SERVICE_LABEL}`)) loaded = false;
    if (file === 'sudo') return cb(new Error('sudo: a password is required'));
    if (args[0] === 'print') {
      if (!loaded) return cb(new Error('Could not find service'));
      return cb(null, { stdout: '\tstate = running\n\tpid = 4242\n', stderr: '' });
    }
    return cb(null, { stdout: '', stderr: '' });
  },
}));

let home: string;
let def: ServiceDefinition;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'launchd-restart-'));
  def = {
    nodePath: '/n/node',
    programPath: '/n/host.mjs',
    home,
    uid: 501,
    env: { HOME: home, USER: 'u' },
  };
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  loaded = true;
});
afterEach(() => {
  calls.length = 0;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const launchctlVerbs = () =>
  calls
    .filter((c) => c[0] === 'launchctl' && !(c[2] ?? '').includes('patch-daemon'))
    .map((c) => c[1]);

describe('launchd update keeps running chats alive', () => {
  it('an unchanged, loaded job is not booted out or re-bootstrapped', async () => {
    writeFileSync(launchdPlistPath(home), launchdPlist(def, false));
    await launchdOps.register(def);
    expect(launchctlVerbs()).not.toContain('bootout');
    expect(launchctlVerbs()).not.toContain('bootstrap');
  });

  it('a changed plist is still re-registered', async () => {
    writeFileSync(launchdPlistPath(home), launchdPlist({ ...def, nodePath: '/old/node' }, false));
    await launchdOps.register(def).catch(() => undefined);
    expect(launchctlVerbs()).toContain('bootout');
  });

  it('start signals only the host pid and never uses kickstart -k', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    await launchdOps.start(def);
    expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(calls.some((c) => c.includes('kickstart'))).toBe(false);
  });

  it('start on a stopped job kickstarts it without -k', async () => {
    loaded = false;
    await launchdOps.start(def);
    const ks = calls.find((c) => c.includes('kickstart'));
    expect(ks).toBeDefined();
    expect(ks).not.toContain('-k');
  });
});
