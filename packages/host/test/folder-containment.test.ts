// A name that merely STARTS with two dots (`..report.html`) is inside the chat
// folder; only a real `..` path segment escapes it.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveArtifactPath, resolveViewFilePath } from '../src/artifacts.js';
import { bundleDir } from '../src/pads.js';

describe('dot-dot prefixed names inside the chat folder', () => {
  it('resolveArtifactPath accepts ..report.html and still refuses ../x.html', () => {
    expect(resolveArtifactPath('/work', '..report.html').relPath).toBe('..report.html');
    expect(() => resolveArtifactPath('/work', '../x.html')).toThrow(/inside the chat folder/);
    expect(() => resolveArtifactPath('/work', '..')).toThrow();
  });

  it('resolveViewFilePath accepts ..shot.png and still refuses ../shot.png', () => {
    expect(resolveViewFilePath('/work', '..shot.png').relPath).toBe('..shot.png');
    expect(() => resolveViewFilePath('/work', '../shot.png')).toThrow(/inside the chat folder/);
  });

  it('bundleDir accepts a folder called ..assets and still refuses ..', () => {
    const folder = mkdtempSync(join(tmpdir(), 'bundle-'));
    mkdirSync(join(folder, '..assets'));
    writeFileSync(join(folder, '..assets', 'index.html'), '<p>a</p>');
    expect(bundleDir(folder, '..assets').length).toBeGreaterThan(0);
    expect(() => bundleDir(folder, '..')).toThrow(/inside the chat folder/);
  });
});
