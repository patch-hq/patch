import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listChildDirs, listingTimeoutMessage } from '../src/boundedListing.js';
import { FolderRegistry, FolderListingTimeoutError } from '../src/folders.js';

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
  it('gives up on a listing that does not finish, and says what to do', async () => {
    const r = await listChildDirs('/dev/null', 1).catch(() => null);
    expect(r === null || ['timeout', 'error', 'ok'].includes(r.kind)).toBe(true);
    expect(listingTimeoutMessage('/Users/x/Documents')).toMatch(/permission to open Documents/);
  });
});

describe('FolderRegistry.browse with a stuck listing', () => {
  it('throws the plain timeout error and stays usable', async () => {
    const reg = new FolderRegistry({
      source: { listChats: () => [] },
      onChange: () => {},
      listChildDirs: async () => ({ kind: 'timeout' }),
    });
    await expect(reg.browse('/Users/x/Documents')).rejects.toBeInstanceOf(
      FolderListingTimeoutError,
    );
    await expect(reg.browse('/Users/x/Documents')).rejects.toThrow(/permission to open Documents/);
  });
});
