// Archiving the open chat moves you on with it (spec/04 § Lifecycle).
//
// Every archive control shares this — the chat header's icon, the sidebar row's
// icon, ⌘⌥A, and the bulk / project archives — so which one you reached for
// never changes where you end up.

import { useEffect } from 'react';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { nextChatAfterArchive } from './chatGroups.js';
import { newChatPath } from './newChat.js';

/**
 * Leave the chats in `archivedIds` behind if the open chat is one of them.
 *
 * Call it BEFORE flipping those rows to archived — the destination is read off
 * the list as it still stands. A no-op when the open chat isn't being archived,
 * so an archive aimed at some other row leaves you where you are.
 */
export function navigateAfterArchive(
  navigate: (to: string) => void,
  archivedIds: readonly string[],
): void {
  const activeChatId = useChatStore.getState().activeChatId;
  if (!activeChatId || !archivedIds.includes(activeChatId)) return;
  // This surface is doing the archiving itself and has moved on; the flip that
  // follows must not be mistaken for an archive from somewhere else.
  leftByThisSurface.add(activeChatId);
  moveOn(navigate, Object.values(useChatStore.getState().chats), activeChatId, archivedIds);
}

const leftByThisSurface = new Set<string>();

/** Test seam: forget which chats this surface has already left. */
export function resetArchiveNav(): void {
  leftByThisSurface.clear();
}

function moveOn(
  navigate: (to: string) => void,
  chats: Parameters<typeof nextChatAfterArchive>[0],
  activeChatId: string,
  archivedIds: readonly string[],
): void {
  const next = nextChatAfterArchive(
    chats,
    activeChatId,
    archivedIds,
    useUiStore.getState().attentionOnly,
    {
      chatSort: useUiStore.getState().chatSort,
      groupSort: useUiStore.getState().groupSort,
    },
  );
  navigate(next === null ? newChatPath() : `/chats/${next}`);
}

/**
 * Archiving the open chat from another surface moves this one on too
 * (spec/04 § Lifecycle): the host's `chat.state` flips the open row to
 * archived, and leaving it open would keep a chat on screen that the other
 * surface has put away. An archive made here has already navigated (it is
 * marked in `leftByThisSurface`), so only a flip nobody here asked for acts.
 */
export function useLeaveWhenArchivedElsewhere(navigate: (to: string) => void): void {
  useEffect(
    () =>
      useChatStore.subscribe((state, prev) => {
        const id = state.activeChatId;
        // Having moved off a chat, nothing is owed about it any more.
        if (prev.activeChatId && id !== prev.activeChatId)
          leftByThisSurface.delete(prev.activeChatId);
        if (!id || id !== prev.activeChatId) return;
        if (state.chats[id]?.status !== 'archived' || prev.chats[id]?.status === 'archived') return;
        if (leftByThisSurface.delete(id)) return;
        // Read off the list as it stood before the flip, as a local archive does.
        moveOn(navigate, Object.values(prev.chats), id, [id]);
      }),
    [navigate],
  );
}
