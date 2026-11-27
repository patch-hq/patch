// The Triage page's queue (spec/14 § Triage): the chats waiting on a reply, in
// the order they arrived — oldest first, so a new one lands at the bottom and
// the page never reshuffles under the cursor.

import type { ChatEventEntry } from '../stores/chatStore.js';
import { isSpecialThread } from './chatGroups.js';
import { deriveBadge, type ChatRow } from '../stores/types.js';

/** A chat the user can answer with a line of text: finished-unread, or left on a question / report. */
export function awaitsReply(row: ChatRow): boolean {
  if (row.status !== 'active' || row.hidden === true) return false;
  // Manager / Speakers are channel threads, not chats to answer one at a time.
  if (isSpecialThread(row.chatId)) return false;
  // Waiting on the user with no approval pending is the agent's own question:
  // a reply answers it. An approval is not something a reply can grant.
  const asking =
    row.chatStatus?.state === 'waiting_for_user' && row.pendingPermissions.length === 0;
  return deriveBadge(row) === 'done' || asking || row.statusKind === 'report';
}

/**
 * Chats awaiting a reply, oldest first. `answered` maps a chat the user just
 * replied to onto the `lastSeq` it had then: it stays out until newer output
 * arrives, which closes the gap before the host reports the chat as running.
 */
export function triageQueue(
  chats: Record<string, ChatRow>,
  answered: ReadonlyMap<string, number>,
): ChatRow[] {
  return Object.values(chats)
    .filter((r) => {
      if (!awaitsReply(r)) return false;
      const at = answered.get(r.chatId);
      return at === undefined || r.lastSeq > at;
    })
    .sort((a, b) => a.lastUpdated - b.lastUpdated || a.chatId.localeCompare(b.chatId));
}

/** The agent's last full message in a transcript, or null if none has loaded. */
export function lastAssistantMessage(timeline: ChatEventEntry[] | undefined): string | null {
  if (!timeline) return null;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i]!;
    if (e.kind === 'message' && e.role === 'assistant' && (e.content ?? '') !== '') {
      return e.content ?? null;
    }
  }
  return null;
}
