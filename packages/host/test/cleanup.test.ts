import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { cutoffMs, DAY_MS, sweepAgentWorktrees } from '../src/cleanup.js';

const logger = pino({ level: 'silent' });
const sh = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, stdio: 'pipe' });

let root: string;
let repo: string;
let remote: string;

function addWorktree(name: string): string {
  const p = join(repo, '.claude', 'worktrees', name);
  sh(repo, 'worktree', 'add', '-b', name, p);
  return p;
}
function age(p: string, days: number): void {
  const t = new Date(Date.now() - days * DAY_MS);
  const gd = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-dir'], { cwd: p })
    .toString()
    .trim();
  for (const f of [p, join(gd, 'HEAD'), join(gd, 'index'), join(gd, 'logs', 'HEAD')]) {
    if (existsSync(f)) utimesSync(f, t, t);
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleanup-'));
  remote = join(root, 'remote.git');
  repo = join(root, 'repo');
  mkdirSync(repo);
  sh(root, 'init', '--bare', remote);
  sh(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-m', 'init');
  sh(repo, 'remote', 'add', 'origin', remote);
  sh(repo, 'push', 'origin', 'main');
  sh(repo, 'fetch', 'origin');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (cutoff: number) => sweepAgentWorktrees({ folders: [repo], cutoff, logger });

describe('sweepAgentWorktrees', () => {
  it('removes an old clean pushed worktree', async () => {
    const p = addWorktree('old');
    age(p, 40);
    const r = await run(cutoffMs(Date.now(), 30));
    expect(r.removed).toEqual([p]);
    expect(existsSync(p)).toBe(false);
  });

  it('keeps a recent worktree', async () => {
    const p = addWorktree('fresh');
    const r = await run(cutoffMs(Date.now(), 30));
    expect(r.removed).toEqual([]);
    expect(existsSync(p)).toBe(true);
  });

  it('never removes a dirty worktree, untracked files included', async () => {
    const p = addWorktree('dirty');
    writeFileSync(join(p, 'new.txt'), 'x');
    age(p, 40);
    const r = await run(cutoffMs(Date.now(), 30));
    expect(r.removed).toEqual([]);
    expect(r.kept[0]?.reason).toBe('uncommitted changes');
    expect(existsSync(p)).toBe(true);
  });

  it('never removes a worktree with unpushed commits', async () => {
    const p = addWorktree('ahead');
    writeFileSync(join(p, 'b.txt'), 'b');
    sh(p, 'add', '.');
    sh(p, 'commit', '-m', 'local');
    age(p, 40);
    const r = await run(cutoffMs(Date.now(), 30));
    expect(r.removed).toEqual([]);
    expect(r.kept[0]?.reason).toBe('unpushed commits');
    expect(existsSync(p)).toBe(true);
  });

  it('ignores worktrees outside .claude/worktrees and non-git folders', async () => {
    const other = join(root, 'other');
    sh(repo, 'worktree', 'add', '-b', 'other', other);
    age(other, 40);
    const r = await sweepAgentWorktrees({
      folders: [repo, root + '/missing'],
      cutoff: cutoffMs(Date.now(), 30),
      logger,
    });
    expect(r.removed).toEqual([]);
    expect(existsSync(other)).toBe(true);
  });
});
