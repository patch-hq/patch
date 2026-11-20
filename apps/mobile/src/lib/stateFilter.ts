// Filtering the Chats tab list by state (spec/15 § Chats tab; mirrors
// packages/web/src/lib/chatGroups.ts's `matchesStateFilter` exactly, off the
// same `deriveBadge` the row's own badge uses, so what you filter for and
// what you see on the row can never disagree).

import { deriveBadge } from '../stores/types';
import type { ChatRow } from '../stores/types';

/** The states the Chats tab's view dropdown can filter down to. */
export type ChatStateFilter = 'all' | 'failed' | 'working' | 'waiting' | 'done';

export function matchesStateFilter(row: ChatRow, filter: ChatStateFilter): boolean {
  if (filter === 'all') return true;
  const badge = deriveBadge(row);
  // A chat the server has not given a status yet is in no state filter: the
  // phone does not assume one (spec/05 § Chat status).
  const pending = row.chatStatus === undefined;
  switch (filter) {
    case 'failed':
      return badge === 'errored';
    case 'working':
      // `background` and `monitoring` both belong here — no turn is in
      // flight, but a command/sub-agent is still running, or a self-wake is
      // armed and will check back on its own.
      return (
        badge === 'working' ||
        badge === 'agents' ||
        badge === 'background' ||
        badge === 'monitoring'
      );
    case 'waiting':
      // Anything paused ON THE USER, as the server says: a permission prompt or
      // an agent that stopped on a question (both `waiting_for_user`).
      return badge === 'permission';
    case 'done':
      // Waiting-on-you chats are ready too: they have responded and the next
      // move is the user's, so Ready is the whole queue of things to look at.
      return !pending && (badge === 'done' || badge === 'read' || badge === 'permission');
  }
}
