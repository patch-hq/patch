// Needs-attention filter + FIFO queue (spec/15-design-mobile.md § Needs
// attention; spec/14-design-web.md § Chat lifecycle → Needs attention
// toggle). Mirrors packages/web/src/lib/chatGroups.ts's `needsAttention` /
// `sortAttentionQueue` exactly, so the phone and the sidebar can never
// disagree about what "needs you" means or what order the queue works
// through.

import { deriveBadge } from '../stores/types';
import type { ChatRow } from '../stores/types';

/**
 * A chat needs attention when its badge is `done` (finished, unread),
 * `permission` (paused, needs a yes/no), or `errored` (the last turn failed —
 * dropping it out here would take a failed chat OUT of the queue, the exact
 * opposite of the point), or when the agent left it on a declared `question`
 * (paused on the user and needs an answer even once seen) or elected to
 * `report` it (the one state the agent chooses for itself). `working` (still
 * going) and `background` / `monitoring` (not yet a result to look at) are
 * deliberately excluded — none of them is a result yet.
 */
export function needsAttention(row: ChatRow): boolean {
  const badge = deriveBadge(row);
  return (
    badge === 'done' ||
    badge === 'permission' ||
    badge === 'errored' ||
    (row.statusKind === 'question' && row.statusDeclared === true) ||
    row.statusKind === 'report'
  );
}

/**
 * Orders an already-filtered needs-attention list the same way the Chats tab
 * orders its folders: the user's own last activity, newest first, chatId as the
 * tiebreak. Nothing an agent does changes that key, so a row never moves under
 * the thumb while the queue is being worked through.
 */
export function sortAttentionQueue(rows: readonly ChatRow[]): ChatRow[] {
  return [...rows].sort((a, b) => b.lastUserActivity - a.lastUserActivity || cmpId(a, b));
}

/** Stable, data-only tiebreaker so ties never resolve to insertion order. */
function cmpId(a: ChatRow, b: ChatRow): number {
  return a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0;
}
