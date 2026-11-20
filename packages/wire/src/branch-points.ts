// Where an edit or a side thread can fork (spec/04 § Forking, § Side threads),
// shared by the host, which forks, and the surfaces, which offer the action
// only where the fork would succeed.
//
// A fork resumes the provider's own session at an entry's provider id
// (`nativeRef`). Surfaces never see the id itself; the server tells them an
// entry has one with `branchable: true`.

import { modelHasCapability, providerDescriptor, providerForModel } from './providers.js';

/** One entry of a track, in seq order, as much of it as the rule needs. */
export interface BranchEntry {
  type: string;
  role?: string;
  /** The entry carries a provider id. */
  branchable?: boolean;
}

/** An entry the provider wrote: its reply, a tool call or a tool result. */
function isProviderOutput(e: BranchEntry): boolean {
  return (
    (e.type === 'chat.message' && e.role === 'assistant') ||
    e.type === 'chat.tool_call' ||
    e.type === 'chat.tool_result'
  );
}

function isUserMessage(e: BranchEntry): boolean {
  return e.type === 'chat.message' && e.role === 'user';
}

/**
 * The index of the entry a branch keeps through (whose provider id the fork
 * resumes at), `'empty'` for a branch that starts from an empty context, or
 * `null` when there is no fork point and the request is refused.
 *
 * - `edit` at a user turn keeps everything before it: the nearest earlier
 *   entry with a provider id. A user turn the provider never answered may have
 *   none and is passed over. With no provider output before it, the branch
 *   starts empty.
 * - `side` keeps the entry it hangs off, which needs its own provider id. A
 *   provider that forks only at whole turns (`branching.wholeTurns`) hangs a
 *   side thread off a user turn the way an edit forks: through the turns before.
 */
export function forkPointIndex(
  kind: 'edit' | 'side',
  entries: readonly BranchEntry[],
  index: number,
  model: string | null | undefined,
): number | 'empty' | null {
  const target = entries[index];
  if (!target) return null;
  const before = (): number | 'empty' | null => {
    let output = false;
    for (let i = index - 1; i >= 0; i -= 1) {
      const e = entries[i]!;
      if (e.branchable) return i;
      if (isProviderOutput(e)) output = true;
    }
    return output ? null : 'empty';
  };
  if (kind === 'edit') return isUserMessage(target) ? before() : null;
  if (target.branchable) return index;
  const { wholeTurns } = providerDescriptor(providerForModel(model)).branching;
  return wholeTurns && isUserMessage(target) ? before() : null;
}

/** Would editing the user turn at `index` fork, on this model? */
export function canEditAt(
  entries: readonly BranchEntry[],
  index: number,
  model: string | null | undefined,
): boolean {
  return (
    modelHasCapability(model, 'editAtMessage') &&
    forkPointIndex('edit', entries, index, model) !== null
  );
}

/** Would a side thread off the entry at `index` fork, on this model? */
export function canSideAt(
  entries: readonly BranchEntry[],
  index: number,
  model: string | null | undefined,
): boolean {
  return (
    modelHasCapability(model, 'branchAtTurn') &&
    forkPointIndex('side', entries, index, model) !== null
  );
}
