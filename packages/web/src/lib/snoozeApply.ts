// Applying a snooze (spec/04 § Snooze, spec/14 § Snooze sheet): the absolute
// wake time is resolved by the caller at confirm time; each chat flips
// optimistically, reverts with a toast if the host refuses, and the open chat
// moves on the way archive does. Undo puts every chat's previous wake time back.

import type { NavigateFunction } from 'react-router-dom';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api } from '../api/rest.js';
import { failed } from './errorCopy.js';
import { navigateAfterArchive } from './archiveNav.js';
import { isSnoozeUntilComplete } from '@patch/wire';
import { formatWakeAt } from './snoozePresets.js';
import type { ChatRow } from '../stores/types.js';

export function newSnoozeSetId(): string {
  return `set-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The second line of the confirmation toast, or null when nothing keeps running. */
export function runningToastLine(running: number, isProject: boolean): string | null {
  if (running === 0) return null;
  if (!isProject) return 'Running in background';
  return `${running} ${running === 1 ? 'chat' : 'chats'} running in background`;
}

export function applySnooze(opts: {
  targets: ChatRow[];
  until: number;
  /** The chat's or project's name, for the toast. */
  name: string;
  isProject: boolean;
  navigate: NavigateFunction;
}): void {
  const { targets, until, name, isProject, navigate } = opts;
  const store = useChatStore.getState();
  const ui = useUiStore.getState();
  const setId = newSnoozeSetId();
  const running = targets.filter((c) => c.activity === 'running').length;
  const previous = new Map(targets.map((c) => [c.chatId, c.snoozedUntil]));

  // Snoozing takes the chats off the list, so move on like archive does —
  // resolved before the flip, while they are still in the list.
  navigateAfterArchive(
    navigate,
    targets.map((c) => c.chatId),
  );
  for (const c of targets) {
    store.setSnoozed(c.chatId, until);
    void api.snoozeChat(c.chatId, until, setId).catch((err) => {
      useChatStore.getState().setSnoozed(c.chatId, previous.get(c.chatId) ?? null);
      useUiStore.getState().pushError(failed('snooze'), undefined, (err as Error).message);
    });
  }

  ui.pushSnoozeToast(
    `${name} snoozed until ${isSnoozeUntilComplete(until) ? 'complete' : formatWakeAt(until)}`,
    runningToastLine(running, isProject),
    () => {
      for (const c of targets) {
        const was = previous.get(c.chatId) ?? null;
        // A wake time already gone is no snooze to restore.
        const restore = was !== null && was > Date.now() ? was : null;
        useChatStore.getState().setSnoozed(c.chatId, restore);
        void api.snoozeChat(c.chatId, restore).catch((err) => {
          useChatStore.getState().setSnoozed(c.chatId, until);
          useUiStore.getState().pushError(failed('undo snooze'), undefined, (err as Error).message);
        });
      }
    },
  );
}
