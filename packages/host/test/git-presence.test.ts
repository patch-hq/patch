import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isInsideGitWorkTree } from '../src/git-presence.js';

describe('isInsideGitWorkTree', () => {
  it('is false for a folder with no .git above it, true inside one that has', () => {
    const root = mkdtempSync(join(tmpdir(), 'gitpresence-'));
    const sub = join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    expect(isInsideGitWorkTree(sub)).toBe(false);
    mkdirSync(join(root, '.git'));
    expect(isInsideGitWorkTree(sub)).toBe(true);
  });
});

import { existsSync, readFileSync } from 'node:fs';
import { envWithoutGitStub, gitIsUsable } from '../src/git-presence.js';

describe('gitIsUsable', () => {
  it('is always true off macOS', () => {
    expect(gitIsUsable('linux', () => false)).toBe(true);
  });
  it('on macOS needs the developer tools or Xcode on disk', () => {
    expect(gitIsUsable('darwin', () => false)).toBe(false);
    expect(gitIsUsable('darwin', (p) => p.startsWith('/Library/Developer/CommandLineTools'))).toBe(
      true,
    );
    expect(gitIsUsable('darwin', (p) => p.startsWith('/Applications/Xcode.app'))).toBe(true);
  });
});

describe('envWithoutGitStub', () => {
  it('leaves the env alone when git is usable', () => {
    const env = { PATH: '/usr/bin' };
    expect(envWithoutGitStub(env, '/nonexistent/shim', true)).toBe(env);
  });
  it('puts a git that says "not a repository" first on PATH when it is not', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'gitshim-')), 'shim');
    const out = envWithoutGitStub({ PATH: '/usr/bin' }, dir, false);
    expect(out['PATH']).toBe(`${dir}:/usr/bin`);
    expect(existsSync(join(dir, 'git'))).toBe(true);
    expect(readFileSync(join(dir, 'git'), 'utf8')).toContain('exit 128');
  });
});

import { listAgentWorktrees } from '../src/cleanup.js';

describe('startup worktree sweep', () => {
  it('rejects a folder with no .git before it starts git', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nogit-'));
    await expect(listAgentWorktrees(root)).rejects.toThrow('not a git work tree');
  });
});
