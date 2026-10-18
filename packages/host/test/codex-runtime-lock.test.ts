// Two installs of the managed Codex runtime into one directory must not run at
// once: npm installs into the same prefix race each other's renames and one
// fails with ENOTEMPTY — which is what parallel test workers (separate
// processes, so the in-process `installing` promise cannot help) kept hitting.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CODEX_VERSION, CodexRuntime } from '../src/codexRuntime.js';

function fakeInstall(log: string[], name: string, ms = 60) {
  return async (root: string): Promise<void> => {
    log.push(`${name} start`);
    await new Promise((r) => setTimeout(r, ms));
    const pkg = join(root, 'node_modules/@openai/codex');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version: CODEX_VERSION }));
    mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules/.bin/codex'), '#!/bin/sh\n');
    log.push(`${name} end`);
  };
}

describe('CodexRuntime install lock', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a second runtime on the same directory waits, then finds it installed instead of installing again', async () => {
    dir = mkdtempSync(join(tmpdir(), 'patch-codex-lock-'));
    const root = join(dir, 'codex');
    const log: string[] = [];
    const a = new CodexRuntime(root, fakeInstall(log, 'a'));
    const b = new CodexRuntime(root, fakeInstall(log, 'b'));
    const [ea, eb] = await Promise.all([a.ensure(), b.ensure()]);
    expect(ea).toBe(eb);
    expect(log).toEqual(['a start', 'a end']);
    expect(existsSync(`${root}.install-lock`)).toBe(false);
  });

  it('a failed install releases the lock for the next attempt', async () => {
    dir = mkdtempSync(join(tmpdir(), 'patch-codex-lock-'));
    const root = join(dir, 'codex');
    const broken = new CodexRuntime(root, async () => {
      throw new Error('npm exploded');
    });
    await expect(broken.ensure()).rejects.toThrow('npm exploded');
    const log: string[] = [];
    await new CodexRuntime(root, fakeInstall(log, 'retry')).ensure();
    expect(log).toEqual(['retry start', 'retry end']);
  });

  it('takes over a lock left behind by a process that died mid-install', async () => {
    dir = mkdtempSync(join(tmpdir(), 'patch-codex-lock-'));
    const root = join(dir, 'codex');
    mkdirSync(`${root}.install-lock`, { recursive: true });
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(`${root}.install-lock`, old, old);
    const log: string[] = [];
    await new CodexRuntime(root, fakeInstall(log, 'c')).ensure();
    expect(log).toEqual(['c start', 'c end']);
  });
});
