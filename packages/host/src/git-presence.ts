// Whether a folder is inside a git work tree, answered from the filesystem.
//
// On a Mac without the developer tools, /usr/bin/git is a stub that pops a
// system "install the command line developer tools" dialog the first time it
// runs. A folder with no `.git` above it can never be a work tree, so ask the
// disk first and only start git where it has something to read.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function isInsideGitWorkTree(folder: string): boolean {
  let dir = resolve(folder);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Whether a real git can run here. Only macOS ships /usr/bin/git as a stub,
 * so only there can git be missing; the answer is read from the disk (the
 * tools' own git, or Xcode's), never by starting git.
 */
export function gitIsUsable(
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): boolean {
  if (platform !== 'darwin') return true;
  return (
    exists('/Library/Developer/CommandLineTools/usr/bin/git') ||
    exists('/Applications/Xcode.app/Contents/Developer/usr/bin/git')
  );
}

/**
 * An env for a child that may run git on its own (Claude Code does, at start
 * and per folder). Without the developer tools, a `git` that answers "not a
 * repository" is put first on PATH so the child never reaches the macOS stub
 * and its install dialog. With them, the env is returned untouched.
 */
export function envWithoutGitStub(
  env: Record<string, string | undefined>,
  shimDir: string,
  usable: boolean = gitIsUsable(),
): Record<string, string | undefined> {
  if (usable) return env;
  mkdirSync(shimDir, { recursive: true });
  const shim = join(shimDir, 'git');
  writeFileSync(
    shim,
    '#!/bin/sh\necho "fatal: not a git repository (Patch: developer tools not installed)" >&2\nexit 128\n',
    {
      mode: 0o755,
    },
  );
  const path = env['PATH'];
  return { ...env, PATH: path ? `${shimDir}:${path}` : shimDir };
}
