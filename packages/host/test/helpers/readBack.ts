// What a surface reads back of a chat once the host's log is in the server's
// record (spec/03 § Chat history): the chat's record as the host sends it
// (`recordForImport`), laid out as one branch's track the way the server does,
// without turn boundaries, provider ids or branch tags. Host tests use it to see
// a chat as a reader does, now that the host never answers a history request.

import { trackFilter, type WireEvent } from '@patch/wire';
import type { Daemon } from '../../src/chatRunner.js';

export function readBack(
  daemon: Pick<Daemon, 'recordForImport' | 'branchesEvent'>,
  chatId: string,
  o: { branchId?: string; fromSeq?: number } = {},
): WireEvent[] {
  const graph = daemon.branchesEvent(chatId);
  const target = o.branchId ?? graph.activeBranchId;
  const inTrack = trackFilter(graph.branches, target);
  const root = graph.branches.find((b) => b.parentBranchId === null)?.branchId ?? target;
  const fromSeq = o.fromSeq ?? -1;
  const out: WireEvent[] = [];
  let last = { seq: -1, branchId: root, kept: false };
  for (const e of daemon.recordForImport(chatId)) {
    if (e.type === 'chat.turn_started' || e.type === 'chat.turn_ended') continue;
    const {
      nativeRef: _ref,
      branchId,
      ...bare
    } = e as WireEvent & {
      nativeRef?: unknown;
      branchId?: string;
    };
    void _ref;
    const seq = (e as { seq?: unknown }).seq;
    if (typeof seq !== 'number') {
      // An answer travels with the question before it.
      if (last.kept) out.push(bare as WireEvent);
      continue;
    }
    const on = branchId ?? (e.type === 'chat.permission_request' ? last.branchId : root);
    const kept = seq > fromSeq && inTrack(seq, on);
    last = { seq, branchId: on, kept };
    if (kept) out.push(bare as WireEvent);
  }
  return out;
}
