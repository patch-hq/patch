// macOS asks for permission before a process reads ~/Documents, ~/Desktop or
// ~/Downloads. When the prompt is never answered (or was refused) the read
// blocks or fails, and every agent tool that touches those folders hangs.
// This probes the same access from the host process itself so `patch doctor`
// can say which permission is missing.

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type FolderStatus = 'ok' | 'denied' | 'timeout';

export interface FolderAccessReport {
  /** False off macOS, where there is nothing to grant. */
  applicable: boolean;
  folders: Array<{ folder: string; status: FolderStatus; detail?: string }>;
  /** What to do, present only when a folder is not readable. */
  advice?: string;
}

const FOLDERS = ['Documents', 'Desktop', 'Downloads'];
export const FOLDER_PROBE_TIMEOUT_MS = 5_000;

export type ListDir = (dir: string, timeoutMs: number) => Promise<FolderStatus>;

const listWithLs: ListDir = (dir, timeoutMs) =>
  new Promise((resolve) => {
    execFile('/bin/ls', [dir], { timeout: timeoutMs }, (err) => {
      if (err === null) resolve('ok');
      else if ((err as NodeJS.ErrnoException & { killed?: boolean }).killed === true)
        resolve('timeout');
      else resolve('denied');
    });
  });

export async function probeFolderAccess(
  opts: {
    platform?: NodeJS.Platform;
    home?: string;
    listDir?: ListDir;
    timeoutMs?: number;
  } = {},
): Promise<FolderAccessReport> {
  if ((opts.platform ?? process.platform) !== 'darwin') return { applicable: false, folders: [] };
  const home = opts.home ?? homedir();
  const list = opts.listDir ?? listWithLs;
  const timeoutMs = opts.timeoutMs ?? FOLDER_PROBE_TIMEOUT_MS;
  const folders = await Promise.all(
    FOLDERS.map(async (folder) => ({ folder, status: await list(join(home, folder), timeoutMs) })),
  );
  const blocked = folders.filter((f) => f.status !== 'ok').map((f) => f.folder);
  return {
    applicable: true,
    folders,
    ...(blocked.length > 0
      ? {
          advice: `The Patch host cannot read ~/${blocked.join(', ~/')}. Grant it Full Disk Access in System Settings > Privacy & Security, or answer the permission prompt waiting on the Mac, then restart the host.`,
        }
      : {}),
  };
}

/**
 * Is `folder` inside ~/Documents, ~/Desktop or ~/Downloads, and if so can the
 * host read it right now? Returns advice text when it cannot, null when it can
 * (or when nothing needs granting). Called before a turn starts: an unanswered
 * macOS prompt blocks the agent's first read with no output, so the chat would
 * sit on its typing dots until the user stops it.
 */
export async function checkChatFolderAccess(
  folder: string,
  opts: {
    platform?: NodeJS.Platform;
    home?: string;
    listDir?: ListDir;
    timeoutMs?: number;
  } = {},
): Promise<string | null> {
  if ((opts.platform ?? process.platform) !== 'darwin') return null;
  const home = opts.home ?? homedir();
  const top = FOLDERS.find((f) => {
    const root = join(home, f);
    return folder === root || folder.startsWith(root + '/');
  });
  if (top === undefined) return null;
  const status = await (opts.listDir ?? listWithLs)(
    folder,
    opts.timeoutMs ?? FOLDER_PROBE_TIMEOUT_MS,
  );
  if (status === 'ok') return null;
  return status === 'timeout'
    ? `macOS is asking for access to ${top} and is waiting for an answer. Click Allow on the prompt on the Mac, then send your message again.`
    : `macOS has blocked Patch from reading ${top}. Allow it in System Settings > Privacy & Security > Files and Folders (or Full Disk Access), then send your message again.`;
}
