// Archiving the open chat from another surface takes this one back to the list
// too (spec/04 § Lifecycle, spec/15 § Chat detail): the host's `chat.state`
// flips the open row to archived, and staying on a chat the other surface has
// put away leaves it on screen as if nothing happened.
//
// An archive made on this screen has already gone back (ChatActionsMenu marks
// the chat), so only a flip nobody here asked for acts.

import React from 'react';
import { goBack, type BackRouter } from './goBack';
import { useChatStore } from '../stores/chatStore';

const leftByThisScreen = new Set<string>();

/** This screen is archiving `chatId` itself and is already going back. */
export function markLeavingForArchive(chatId: string): void {
  leftByThisScreen.add(chatId);
}

export function useLeaveWhenArchivedElsewhere(
  chatId: string,
  router: BackRouter,
  parent: Parameters<typeof goBack>[1],
): void {
  const archived = useChatStore((s) => s.chats[chatId]?.status === 'archived');
  const wasArchived = React.useRef(archived);
  React.useEffect(() => {
    const was = wasArchived.current;
    wasArchived.current = archived;
    if (was || !archived) return;
    if (leftByThisScreen.delete(chatId)) return;
    goBack(router, parent);
  }, [archived, chatId, router, parent]);
}
