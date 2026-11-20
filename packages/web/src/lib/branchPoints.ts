// Where a surface offers edit and side thread (spec/04 § Forking, § Side
// threads): only where the fork would succeed, by the rule the host forks by
// (`forkPointIndex` in @patch/wire).

import { canEditAt, canSideAt, type BranchEntry } from '@patch/wire';
import type { ChatEventEntry } from '../stores/chatStore.js';

/** One shared object per answer, so an unchanged row is handed the same prop. */
const POINTS = {
  none: { edit: false, side: false },
  edit: { edit: true, side: false },
  side: { edit: false, side: true },
  both: { edit: true, side: true },
} as const;

const TYPES: Partial<Record<ChatEventEntry['kind'], string>> = {
  message: 'chat.message',
  tool_call: 'chat.tool_call',
  tool_result: 'chat.tool_result',
};

/**
 * For each settled entry of the track, by seq: can it be edited, can a side
 * thread hang off it. An entry still on its way (queued, or the optimistic echo
 * of a send) is not in the record yet and is left out.
 */
export function branchPointsOf(
  timeline: readonly ChatEventEntry[],
  model: string | null | undefined,
): Map<number, { edit: boolean; side: boolean }> {
  const settled = timeline.filter((e) => !e.queued && e.localId === undefined);
  const entries: BranchEntry[] = settled.map((e) => ({
    type: TYPES[e.kind] ?? e.kind,
    ...(e.role !== undefined ? { role: e.role } : {}),
    ...(e.branchable ? { branchable: true } : {}),
  }));
  const out = new Map<number, { edit: boolean; side: boolean }>();
  settled.forEach((e, i) => {
    const edit = canEditAt(entries, i, model);
    const side = canSideAt(entries, i, model);
    out.set(e.seq, edit ? (side ? POINTS.both : POINTS.edit) : side ? POINTS.side : POINTS.none);
  });
  return out;
}
