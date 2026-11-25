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
