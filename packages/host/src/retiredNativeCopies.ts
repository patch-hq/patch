// The pre-migration copies of each chat's Claude transcript (spec/04 § History).
//
// Before each chat had its own Claude config dir, the host kept a copy of the
// chat's Claude conversation under `~/.patch/chats/<chatId>/native/claude/`.
// Every resume since has copied that into the chat's own dir, and nothing reads
// the old copies any more: what a chat shows comes from the server's record.
//
// This removes them once. A session that was never resumed after the move has
// no copy of its own yet, so it is carried into the chat's own dir first and
// can still be resumed. A marker file records that the sweep is done, so later
// starts do not walk every chat's folder again.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from 'pino';
import { chatTranscriptPath } from './claudeSessionStore.js';

/** Written to the Patch home once the sweep has finished. */
export const RETIRED_NATIVE_COPIES_MARKER = '.retired-native-copies';

/** `~/.patch/chats/<chatId>/native/claude`: where the old copies lived. */
export function retiredNativeDir(chatDir: string): string {
  return join(chatDir, 'native', 'claude');
}

export interface RetiredNativeCopiesResult {
  /** True when the marker said the sweep had already run. */
  skipped: boolean;
  /** Chats whose old copies were removed. */
  removed: number;
  /** Sessions carried into the chat's own dir before their old copy went. */
  carried: number;
  /** Chats left alone because something failed; tried again next start. */
  failed: number;
}

export function removeRetiredNativeCopies(opts: {
  patchHome: string;
  /** The chat's working folder, which names its transcript's place; undefined when unknown. */
  folderOf: (chatId: string) => string | undefined;
  logger: Pick<Logger, 'info' | 'warn'>;
}): RetiredNativeCopiesResult {
  const result: RetiredNativeCopiesResult = { skipped: false, removed: 0, carried: 0, failed: 0 };
  const marker = join(opts.patchHome, RETIRED_NATIVE_COPIES_MARKER);
  if (existsSync(marker)) return { ...result, skipped: true };
  const root = join(opts.patchHome, 'chats');
  const ids = existsSync(root) ? readdirSync(root) : [];
  for (const chatId of ids) {
    const chatDir = join(root, chatId);
    const legacy = retiredNativeDir(chatDir);
    if (!existsSync(legacy)) continue;
    try {
      const sessions = readdirSync(legacy).filter((f) => f.endsWith('.jsonl'));
      const folder = sessions.length > 0 ? opts.folderOf(chatId) : undefined;
      if (sessions.length > 0 && folder === undefined) {
        throw new Error('the chat has no readable folder, so its old copy cannot be carried over');
      }
      for (const file of sessions) {
        const from = join(legacy, file);
        if (statSync(from).size === 0) continue;
        const target = chatTranscriptPath(chatDir, folder!, file.slice(0, -'.jsonl'.length));
        if (existsSync(target) && statSync(target).size > 0) continue;
        mkdirSync(dirname(target), { recursive: true });
        const tmp = `${target}.tmp-${process.pid}`;
        copyFileSync(from, tmp);
        renameSync(tmp, target);
        result.carried++;
      }
      rmSync(legacy, { recursive: true, force: true });
      // `native/` held nothing else; leave it if something else has appeared there.
      const parent = dirname(legacy);
      if (readdirSync(parent).length === 0) rmdirSync(parent);
      result.removed++;
    } catch (err) {
      result.failed++;
      opts.logger.warn(
        { chatId, err: (err as Error).message },
        'could not remove the old copy of a chat’s Claude transcript; will try again next start',
      );
    }
  }
  if (result.failed === 0) writeFileSync(marker, `${new Date().toISOString()}\n`);
  if (result.removed > 0 || result.failed > 0) {
    opts.logger.info(
      { removed: result.removed, carried: result.carried, failed: result.failed },
      'removed the old copies of chats’ Claude transcripts',
    );
  }
  return result;
}
