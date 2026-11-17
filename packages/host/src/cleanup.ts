// Startup cleanup (`cleanupPeriodDays`, shared setting). Mirrors Claude Code's
// own `cleanupPeriodDays`, but covers only what Patch owns: its chat logs and
// the agent worktrees its chats' agents leave under `<repo>/.claude/worktrees`.
//
// NO FALLBACK: a worktree is removed only when every check positively says it
// is safe. A git error, an unreadable directory or an unexpected output means
// "leave it and log it", never "assume clean".

import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Logger } from 'pino';

const execFileAsync = promisify(execFile);

export const DAY_MS = 86_400_000;

export function cutoffMs(now: number, periodDays: number): number {
  return now - periodDays * DAY_MS;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export interface AgentWorktree {
  /** The repo's main work tree, from which `git worktree remove` is run. */
  repo: string;
  path: string;
}

/** Agent worktrees of the repo containing `folder`: those under `.claude/worktrees`. */
export async function listAgentWorktrees(folder: string): Promise<AgentWorktree[]> {
  const common = (
    await git(folder, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  ).trim();
  const repo = resolve(common, '..');
  const root = join(repo, '.claude', 'worktrees') + sep;
  const out = await git(repo, ['worktree', 'list', '--porcelain']);
  const found: AgentWorktree[] = [];
  for (const line of out.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const path = line.slice('worktree '.length);
    if (path.startsWith(root)) found.push({ repo, path });
  }
  return found;
}

/** Newest mtime among the worktree's own git bookkeeping and its directory. */
async function lastActivityMs(wt: AgentWorktree): Promise<number> {
  const gitDir = (await git(wt.path, ['rev-parse', '--path-format=absolute', '--git-dir'])).trim();
  let newest = statSync(wt.path).mtimeMs;
  for (const f of ['HEAD', 'index', 'logs/HEAD']) {
    try {
      newest = Math.max(newest, statSync(join(gitDir, f)).mtimeMs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return newest;
}

/** True when the worktree has uncommitted changes (untracked files included). */
async function isDirty(path: string): Promise<boolean> {
  return (await git(path, ['status', '--porcelain', '--untracked-files=all'])).trim() !== '';
}

/** True when HEAD holds any commit that no remote-tracking ref contains. */
async function hasUnpushed(path: string): Promise<boolean> {
  return (await git(path, ['rev-list', '-n', '1', 'HEAD', '--not', '--remotes'])).trim() !== '';
}

export interface WorktreeSweepResult {
  removed: string[];
  kept: Array<{ path: string; reason: string }>;
}

/**
 * Remove agent worktrees untouched for `cutoff` that are clean and fully
 * pushed. `folders` are the distinct chat folders; each is mapped to its repo
 * once. Never forces: `git worktree remove` itself refuses a dirty tree.
 */
export async function sweepAgentWorktrees(opts: {
  folders: Iterable<string>;
  cutoff: number;
  logger: Logger;
}): Promise<WorktreeSweepResult> {
  const result: WorktreeSweepResult = { removed: [], kept: [] };
  const seen = new Set<string>();
  for (const folder of new Set(opts.folders)) {
    let worktrees: AgentWorktree[];
    try {
      worktrees = await listAgentWorktrees(folder);
    } catch (err) {
      // A folder that is not a git repo (or is gone) has no worktrees to sweep.
      opts.logger.debug({ folder, err: String(err) }, 'cleanup: not a git folder, skipped');
      continue;
    }
    for (const wt of worktrees) {
      if (seen.has(wt.path)) continue;
      seen.add(wt.path);
      try {
        if ((await lastActivityMs(wt)) > opts.cutoff) {
          result.kept.push({ path: wt.path, reason: 'recent' });
        } else if (await isDirty(wt.path)) {
          result.kept.push({ path: wt.path, reason: 'uncommitted changes' });
        } else if (await hasUnpushed(wt.path)) {
          result.kept.push({ path: wt.path, reason: 'unpushed commits' });
        } else {
          await git(wt.repo, ['worktree', 'remove', wt.path]);
          result.removed.push(wt.path);
          opts.logger.info({ path: wt.path }, 'cleanup: removed stale agent worktree');
        }
      } catch (err) {
        result.kept.push({ path: wt.path, reason: `check failed: ${String(err)}` });
        opts.logger.warn({ path: wt.path, err: String(err) }, 'cleanup: worktree left in place');
      }
    }
  }
  return result;
}
