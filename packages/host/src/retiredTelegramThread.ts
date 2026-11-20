// What the retired Telegram thread left in the Patch home (spec/06: the
// Telegram thread does not exist).
//
// The thread ran in `<patch home>/threads/telegram`, beside the Manager's and
// Speakers' folders. Nothing creates or reads it any more, but on a relocated
// home it is a bare path with no dot segment, so it would reach folder pickers
// as though it were one of the person's projects. It is removed when empty.
// One that still holds files is left alone and said so: what is in it may be
// the person's, and is theirs to delete.

import { existsSync, readdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';

export function retiredTelegramFolder(patchHome: string): string {
  return join(patchHome, 'threads', 'telegram');
}

/** Remove the retired Telegram thread's empty folder. Returns what happened. */
export function removeRetiredTelegramFolder(
  patchHome: string,
  logger: Pick<Logger, 'info' | 'warn'>,
): 'absent' | 'removed' | 'kept' {
  const folder = retiredTelegramFolder(patchHome);
  if (!existsSync(folder)) return 'absent';
  const entries = readdirSync(folder);
  if (entries.length > 0) {
    logger.warn(
      { folder, entries: entries.length },
      'the retired Telegram thread folder still holds files; left for you to delete',
    );
    return 'kept';
  }
  rmdirSync(folder);
  logger.info({ folder }, 'removed the retired Telegram thread folder');
  return 'removed';
}
