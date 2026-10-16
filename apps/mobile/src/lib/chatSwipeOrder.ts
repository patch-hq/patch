// Swipe left/right on a chat to step to its neighbour. The order is the Chats
// tab's own top-to-bottom order of live chats: Manager, Pinned, then each
// project folder (A→Z) with its chats by the user's last activity. Channels,
// Hidden, Snoozed and Archived are outside it — a chat opened from one of those
// has no neighbours, so swiping there does nothing.

import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { isHidden, isSnoozed, type ChatRow } from '../stores/types';

const MANAGER_ID = SPECIAL_THREAD_IDS.manager;
const SPEAKERS_ID = SPECIAL_THREAD_IDS.speakers;

export function swipeOrder(chats: Record<string, ChatRow>): string[] {
  const all = Object.values(chats);
  const live = all.filter(
    (c) =>
      c.chatId !== MANAGER_ID &&
      c.chatId !== SPEAKERS_ID &&
      c.status !== 'archived' &&
      c.status !== 'deleted' &&
      !isHidden(c) &&
      !isSnoozed(c),
  );
  const pinned = live.filter((c) => c.pinned).sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
  const folders = new Map<string, ChatRow[]>();
  for (const c of live) {
    if (c.pinned) continue;
    const list = folders.get(c.folder) ?? [];
    list.push(c);
    folders.set(c.folder, list);
  }
  const out: string[] = [];
  if (chats[MANAGER_ID]) out.push(MANAGER_ID);
  for (const c of pinned) out.push(c.chatId);
  const paths = [...folders.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const p of paths) {
    for (const c of folders.get(p)!.sort((a, b) => b.lastUserActivity - a.lastUserActivity)) {
      out.push(c.chatId);
    }
  }
  return out;
}

/** The chats either side of `chatId`; null at an end of the list or when the chat is not in it. */
export function swipeNeighbours(
  chats: Record<string, ChatRow>,
  chatId: string,
): { prev: string | null; next: string | null } {
  const order = swipeOrder(chats);
  const i = order.indexOf(chatId);
  if (i < 0) return { prev: null, next: null };
  return { prev: order[i - 1] ?? null, next: order[i + 1] ?? null };
}
