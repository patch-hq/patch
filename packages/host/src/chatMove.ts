// The on-disk half of retiring a chat that has gone to another host (spec/04
// § Moving to another host).
//
// Moving no longer copies a chat: it starts a new chat on the target host,
// linked to the old one, and no provider session is carried. What remains is
// paying the debt a move before linked chats could leave behind — a host that
// was offline while its chat was taken over from the server's copy is asked,
// when it returns, to set its old copy aside — and where a folder's composer
// attachments live.

import { mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { encodeFolder } from './history.js';

export class ChatMoveError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'busy'
      | 'unsupported'
      | 'folder_not_found'
      | 'already_exists'
      | 'too_large'
      | 'internal',
    message: string,
  ) {
    super(message);
    this.name = 'ChatMoveError';
  }
}

export interface ChatMovePaths {
  /** `~/.patch/chats`. */
  chatsRoot: string;
  /** `~/.patch/moved` — where a moved-away chat's directory is kept. */
  movedRoot: string;
}

/**
 * Where a folder's composer attachments live: the host's own state dir, never
 * the user's project folder.
 */
export function attachmentsDirFor(attachmentsRoot: string, folder: string): string {
  return join(attachmentsRoot, encodeFolder(folder));
}

/**
 * Take a moved-away chat's directory out of the set this host loads, keeping
 * it under `~/.patch/moved/` so it can be recovered by hand. Returns where it
 * went.
 */
export function setAsideMovedChat(chatId: string, paths: ChatMovePaths, now: number): string {
  const chatDir = join(paths.chatsRoot, chatId);
  mkdirSync(paths.movedRoot, { recursive: true });
  const dest = join(paths.movedRoot, `${chatId}-${now}`);
  renameSync(chatDir, dest);
  return dest;
}
