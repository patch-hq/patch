// The server once kept a second copy of every chat's message text under
// `<dataDir>/chat-mirror/` so an offline host's chats stayed searchable. Search
// now reads the server's record of each chat (`chat-log-store.ts`), so the copy
// is removed from disk once, on the first start without it. After that the
// folder is gone and this does nothing.

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';

export const RETIRED_CHAT_MIRROR_DIR = 'chat-mirror';

/** Remove the retired mirror folder. True when there was one to remove. */
export function removeRetiredChatMirror(
  dataDir: string,
  logger: Pick<Logger, 'info' | 'warn'>,
): boolean {
  const dir = join(dataDir, RETIRED_CHAT_MIRROR_DIR);
  if (!existsSync(dir)) return false;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    // A leftover copy harms nothing but disk space: say so, and try again next start.
    logger.warn({ err: (err as Error).message, dir }, 'could not remove the retired chat mirror');
    return false;
  }
  logger.info({ dir }, 'removed the retired chat mirror');
  return true;
}
