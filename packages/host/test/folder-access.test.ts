import { describe, expect, it } from 'vitest';
import {
  checkChatFolderAccess,
  probeFolderAccess,
  type FolderStatus,
} from '../src/folderAccess.js';

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

describe('checkChatFolderAccess', () => {
  const base = { platform: 'darwin' as const, home: '/h' };
  it('ignores folders outside the protected ones and other platforms', async () => {
    const never = async (): Promise<FolderStatus> => 'timeout';
    expect(await checkChatFolderAccess('/h/code', { ...base, listDir: never })).toBeNull();
    expect(
      await checkChatFolderAccess('/h/Documents/x', {
        platform: 'linux',
        home: '/h',
        listDir: never,
      }),
    ).toBeNull();
  });
  it('is quiet when the protected folder is readable', async () => {
    expect(
      await checkChatFolderAccess('/h/Documents/x', { ...base, listDir: async () => 'ok' }),
    ).toBeNull();
  });
  it('says macOS is waiting on a prompt when the read hangs', async () => {
    const msg = await checkChatFolderAccess('/h/Documents', {
      ...base,
      listDir: async () => 'timeout',
    });
    expect(msg).toMatch(/Documents.*waiting for an answer/);
  });
  it('points at Privacy settings when the read is refused', async () => {
    const msg = await checkChatFolderAccess('/h/Desktop/a', {
      ...base,
      listDir: async () => 'denied',
    });
    expect(msg).toMatch(/Desktop.*Privacy & Security/);
  });
});
