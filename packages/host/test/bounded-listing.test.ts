import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listChildDirs } from '../src/boundedListing.js';
import { FolderRegistry } from '../src/folders.js';

describe('listChildDirs', () => {
  it('lists child directories and linked directories, not files', async () => {
    const d = mkdtempSync(join(tmpdir(), 'bl-'));
    mkdirSync(join(d, 'a'));
    mkdirSync(join(d, 'b'));
    writeFileSync(join(d, 'f.txt'), 'x');
    symlinkSync(join(d, 'a'), join(d, 'link'));
    const r = await listChildDirs(d);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.names.sort()).toEqual(['a', 'b', 'link']);
  });
  it('reports a missing directory as an error', async () => {
    expect((await listChildDirs('/no/such/dir-xyz')).kind).toBe('error');
  });
  it('reports a refused read as denied, not as missing', async () => {
    const { listChildDirsWithin } = await import('../src/boundedListing.js');
    expect((await listChildDirsWithin('/no/such/dir-xyz')).kind).toBe('error');
  });
});

describe('FolderRegistry.browse while a folder waits on macOS', () => {
  const mk = (kind: 'pending' | 'denied') =>
    new FolderRegistry({
      source: { listChats: () => [] },
      onChange: () => {},
      listChildDirs: async () => ({ kind }),
    });
  it('says it is still opening, without guessing why', async () => {
    await expect(mk('pending').browse('/Users/x/Documents')).rejects.toMatchObject({
      code: 'still_opening',
      message: 'Still opening Documents…',
    });
  });
  it("says so plainly when the user clicked Don't Allow", async () => {
    await expect(mk('denied').browse('/Users/x/Documents')).rejects.toMatchObject({
      code: 'permission_denied',
      message: expect.stringMatching(/didn't allow Patch to open Documents/),
    });
  });
});

describe('listChildDirsWithin', () => {
  it('stays pending past its window, then a retry joins the same read', async () => {
    const { listChildDirsWithin } = await import('../src/boundedListing.js');
    const d = mkdtempSync(join(tmpdir(), 'bl-'));
    mkdirSync(join(d, 'a'));
    expect((await listChildDirsWithin(d, 0)).kind).toMatch(/pending|ok/);
    expect((await listChildDirsWithin(d, 5000)).kind).toBe('ok');
  });
});
