// Which entries make up one track (branch) of a chat (spec/04 § Branching).
// Shared by the host, which reads its own log this way, and the server, which
// answers every history request from its record this way.

/** The part of a branch a track is worked out from. */
export interface TrackBranch {
  branchId: string;
  parentBranchId: string | null;
  forkFromSeq: number | null;
  sideThread?: true;
}

export interface TrackSegment {
  branchId: string;
  /** Entries on this branch with seq <= this bound belong to the track. */
  upperBound: number;
}

/**
 * The chain of (branch, upper-seq-bound) segments a track is made of, root
 * last. The target branch's own segment has no bound (`Infinity`): every entry
 * it ever carries belongs to it.
 *
 * Each ancestor's bound is where its child forked from, but an edit fork and a
 * side thread disagree about whether the fork point itself belongs to the
 * parent's part: editing a message replaces it (the fork provides its own),
 * while a side thread hangs new content off a message both tracks show. So the
 * parent's bound is `forkFromSeq - 1` for an edit fork and `forkFromSeq` for a
 * side thread. A branch the graph does not name has an empty chain.
 */
export function branchChain(
  branches: readonly TrackBranch[],
  targetBranchId: string,
): TrackSegment[] {
  const byId = new Map(branches.map((b) => [b.branchId, b]));
  const chain: TrackSegment[] = [];
  let cur = byId.get(targetBranchId);
  let upperBound = Number.POSITIVE_INFINITY;
  const visited = new Set<string>();
  while (cur && !visited.has(cur.branchId)) {
    visited.add(cur.branchId);
    chain.push({ branchId: cur.branchId, upperBound });
    if (cur.parentBranchId === null) break;
    // A fork point can sit on a message this branch only inherited, so the
    // bound already in effect still caps every ancestor further up.
    upperBound = Math.min(
      upperBound,
      cur.forkFromSeq === null || cur.forkFromSeq === undefined
        ? Number.POSITIVE_INFINITY
        : cur.sideThread
          ? cur.forkFromSeq
          : cur.forkFromSeq - 1,
    );
    cur = byId.get(cur.parentBranchId);
  }
  return chain;
}

/** A test for "is the entry at `seq`, on `branchId`, part of this track". */
export function trackFilter(
  branches: readonly TrackBranch[],
  targetBranchId: string,
): (seq: number, branchId: string) => boolean {
  const bounds = new Map(
    branchChain(branches, targetBranchId).map((c) => [c.branchId, c.upperBound]),
  );
  return (seq, branchId) => {
    const bound = bounds.get(branchId);
    return bound !== undefined && seq <= bound;
  };
}
