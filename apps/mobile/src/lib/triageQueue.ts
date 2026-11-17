// The Triage screen's queue (spec/14 § Triage). Mirrors
// packages/web/src/lib/triageQueue.ts so the phone and the web page agree on
// which chats are waiting for a reply and in what order.

import { deriveBadge } from '../stores/types';
import type { ChatRow } from '../stores/types';
import type { ChatEventEntry } from '../stores/chatStore';

/** A chat the user can answer with a line of text: finished-unread, or left on a question / report. */
export function awaitsReply(row: ChatRow): boolean {
  if (row.status !== 'active' || row.hidden === true) return false;
  return (
    deriveBadge(row) === 'done' ||
    (row.statusKind === 'question' && row.statusDeclared === true) ||
    row.statusKind === 'report'
  );
}

/**
 * Chats awaiting a reply, oldest first, so a new arrival lands at the end.
 * `answered` maps a chat just replied to onto the `lastSeq` it had then: it
 * stays out until newer output arrives.
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
