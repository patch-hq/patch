import { describe, expect, it } from 'vitest';
import { probeFolderAccess, type FolderStatus } from '../src/folderAccess.js';

describe('probeFolderAccess', () => {
  it('is not applicable off macOS', async () => {
    expect(await probeFolderAccess({ platform: 'linux' })).toEqual({
      applicable: false,
      folders: [],
    });
  });

  it('reports every folder readable with no advice', async () => {
    const r = await probeFolderAccess({
      platform: 'darwin',
      home: '/h',
      listDir: async () => 'ok',
    });
    expect(r.folders.map((f) => f.status)).toEqual(['ok', 'ok', 'ok']);
    expect(r.advice).toBeUndefined();
  });

  it('names the blocked folders and the permission to grant', async () => {
    const listDir = async (dir: string): Promise<FolderStatus> =>
      dir.endsWith('Documents') ? 'timeout' : dir.endsWith('Desktop') ? 'denied' : 'ok';
    const r = await probeFolderAccess({ platform: 'darwin', home: '/h', listDir });
    expect(r.advice).toMatch(/~\/Documents, ~\/Desktop/);
    expect(r.advice).toMatch(/Full Disk Access/);
  });

  it('treats an unreadable directory as denied using the real ls', async () => {
    // Real execFile path.
    const r = await probeFolderAccess({ platform: 'darwin', home: '/nonexistent-home-xyz' });
    expect(r.folders.every((f) => f.status === 'denied')).toBe(true);
  });
});
