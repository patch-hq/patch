import { describe, it, expect } from 'vitest';
import { branchChain, trackFilter } from '../src/branch-track.js';

const graph = [
  { branchId: 'main', parentBranchId: null, forkFromSeq: null },
  { branchId: 'edit', parentBranchId: 'main', forkFromSeq: 4 },
  { branchId: 'side', parentBranchId: 'edit', forkFromSeq: 2, sideThread: true as const },
];

describe('branch tracks (spec/04 § Branching)', () => {
  it('chains a branch to the root, each ancestor bounded by its fork point', () => {
    expect(branchChain(graph, 'edit')).toEqual([
      { branchId: 'edit', upperBound: Infinity },
      { branchId: 'main', upperBound: 3 },
    ]);
    // A fork point inherited from further up keeps capping every ancestor.
    expect(branchChain(graph, 'side')).toEqual([
      { branchId: 'side', upperBound: Infinity },
      { branchId: 'edit', upperBound: 2 },
      { branchId: 'main', upperBound: 2 },
    ]);
  });

  it('names nothing for a branch the graph does not hold', () => {
    expect(branchChain(graph, 'nope')).toEqual([]);
    expect(trackFilter(graph, 'nope')(0, 'main')).toBe(false);
  });

  it('tests whether an entry belongs to a track', () => {
    const onEdit = trackFilter(graph, 'edit');
    expect(onEdit(3, 'main')).toBe(true);
    expect(onEdit(4, 'main')).toBe(false); // the edited message is replaced
    expect(onEdit(9, 'edit')).toBe(true);
    expect(onEdit(5, 'side')).toBe(false);
  });
});
