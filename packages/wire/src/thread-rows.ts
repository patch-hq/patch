// What a chat row is blocked on (spec/14 § Main chat panel): a native
// decision, a declared question, a report, work in progress, or nothing.
// Structural on purpose: each surface keeps its own store row type, and this
// reads only the fields the rule needs.

import type { ChatStatus, StatusKind } from './events.js';

/** The slice of a surface's chat row the ordering reads. */
export interface ThreadRankInput {
  chatId: string;
  status: ChatStatus;
  /** The chat's status as the server decided it (spec/12 § Chat status). */
  chatStatus?: { state: string };
  lastUpdated: number;
  snoozedUntil: number | null;
  pendingPermissions: readonly unknown[];
  statusKind: StatusKind | null;
  statusDeclared: boolean | null;
}

/** What a row is blocked on — the same precedence the watch loop ranks by. */
export type ThreadRowState = 'permission' | 'question' | 'report' | 'working' | 'idle';

export function threadRowState(row: ThreadRankInput): ThreadRowState {
  // A NATIVE pending decision. A native request auto-expires, so it is the
  // more urgent of the two ways a chat can be blocked on the user; a declared
  // question just waits.
  const state = row.chatStatus?.state;
  // A declared question (`patch_ask_human`) with nothing native pending is the
  // agent asking; a generated `question` guess never ranks a row as blocked.
  const declared = row.statusKind === 'question' && row.statusDeclared === true;
  if (state === 'waiting_for_user') {
    return row.pendingPermissions.length === 0 && declared ? 'question' : 'permission';
  }
  // Not blocked, so it ranks below anything that is — but above a chat still
  // working, because the agent has already decided this one is worth seeing.
  if (row.statusKind === 'report') return 'report';
  if (state === 'running') return 'working';
  return 'idle';
}
