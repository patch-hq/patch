// Whether a folder is inside a git work tree, answered from the filesystem.
//
// On a Mac without the developer tools, /usr/bin/git is a stub that pops a
// system "install the command line developer tools" dialog the first time it
// runs. A folder with no `.git` above it can never be a work tree, so ask the
// disk first and only start git where it has something to read.

import { existsSync } from 'node:fs';
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
