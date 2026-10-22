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
  // A chat the host has said nothing about yet (no events, no state frame) has
  // just been spawned and is waiting on its first turn: pending, so Working —
  // never Ready, which its idle `read` badge would otherwise put it in.
  const pending = row.lastSeq === 0 && row.lastUpdated === 0;
  switch (filter) {
    case 'failed':
      return badge === 'errored';
    case 'working':
      // `background` and `monitoring` both belong here — no turn is in
      // flight, but a command/sub-agent is still running, or a self-wake is
      // armed and will check back on its own.
      return pending || badge === 'working' || badge === 'background' || badge === 'monitoring';
    case 'waiting':
      // Anything paused ON THE USER: a permission prompt, or an agent that
      // stopped on a declared question.
      return (
        badge === 'permission' || (row.statusKind === 'question' && row.statusDeclared === true)
      );
    case 'done':
      return !pending && (badge === 'done' || badge === 'read');
  }
}
