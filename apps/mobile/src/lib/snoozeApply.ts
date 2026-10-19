// Applying a snooze from the sheet (spec/04 § Snooze, spec/15 § Snooze sheet):
// the absolute wake time is resolved by the caller at confirm time; each chat
// flips optimistically, reverts with a toast if the host refuses, and Undo puts
// every chat's previous wake time back. Mirrors packages/web/src/lib/snoozeApply.ts.

import { isReservedSpecialThread } from '@patch/wire';
import { SNOOZE_UNTIL_COMPLETE, formatWakeAt } from '@patch/wire';
import type { ChatRow } from '../stores/types';
import { useChatStore } from '../stores/chatStore';
import { useUiStore } from '../stores/uiStore';
import { api } from '../api/rest';

export function newSnoozeSetId(): string {
  return `set-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The second line of the confirmation toast, or null when nothing keeps running. */
export function runningToastLine(running: number, isProject: boolean): string | null {
  if (running === 0) return null;
  if (!isProject) return 'Running in background';
  return `${running} ${running === 1 ? 'chat' : 'chats'} running in background`;
}

/**
 * Every chat a project snooze reaches: the folder's chats that are not special
 * threads and not archived or deleted — snoozed and pinned ones included.
 */
export function chatsInFolder(all: ChatRow[], folder: string): ChatRow[] {
  return all
    .filter(
      (c) =>
        c.folder === folder &&
        !isReservedSpecialThread(c.chatId) &&
        c.status !== 'archived' &&
        (c.status as string) !== 'deleted',
    )
    .sort((a, b) => b.lastUpdated - a.lastUpdated || (a.chatId < b.chatId ? -1 : 1));
}

export function applySnoozeSet(opts: {
  targets: ChatRow[];
  until: number;
  /** The chat's or project's name, for the toast. */
  name: string;
  isProject: boolean;
}): void {
  const { targets, until, name, isProject } = opts;
  const setId = newSnoozeSetId();
  const running = targets.filter((c) => c.activity === 'running').length;
  const previous = new Map(targets.map((c) => [c.chatId, c.snoozedUntil]));

  for (const c of targets) {
    useChatStore.getState().setSnoozed(c.chatId, until);
    void api.snoozeChat(c.chatId, until, setId).catch((e: Error) => {
      useChatStore.getState().setSnoozed(c.chatId, previous.get(c.chatId) ?? null);
      useUiStore.getState().pushError(`snooze failed: ${e.message}`);
    });
  }

  useUiStore
    .getState()
    .pushSnoozeToast(
      `${name} snoozed until ${until === SNOOZE_UNTIL_COMPLETE ? 'complete' : formatWakeAt(until)}`,
      runningToastLine(running, isProject),
      () => {
        for (const c of targets) {
          const was = previous.get(c.chatId) ?? null;
          // A wake time already gone is no snooze to restore.
          const restore = was !== null && was > Date.now() ? was : null;
          useChatStore.getState().setSnoozed(c.chatId, restore);
          void api.snoozeChat(c.chatId, restore).catch((e: Error) => {
            useChatStore.getState().setSnoozed(c.chatId, until);
            useUiStore.getState().pushError(`undo snooze failed: ${e.message}`);
          });
        }
      },
    );
}
