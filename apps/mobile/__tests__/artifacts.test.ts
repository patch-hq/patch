// src/lib/artifacts.ts — deriving the artifact bar's rows from a chat's
// timeline (spec/15 § Artifacts), newest-published-first, mirroring web's
// packages/web/src/__tests__/artifacts.test.ts.

import { describe, it, expect } from 'vitest';
import { deriveArtifacts, mergeArtifacts } from '../src/lib/artifacts';
import type { ChatEventEntry } from '../src/stores/chatStore';

const artifactEntry = (seq: number, artifactId: string, title: string): ChatEventEntry => ({
  seq,
  kind: 'artifact',
  artifactId,
  artifactTitle: title,
  artifactUrl: `/api/chats/c1/artifact/${artifactId}`,
  artifactPath: `out/${artifactId}.html`,
  at: 0,
});

describe('deriveArtifacts', () => {
  it('returns nothing for a timeline with no artifacts', () => {
    expect(deriveArtifacts([{ seq: 1, kind: 'message', content: 'hi', at: 0 }])).toEqual([]);
  });

  it('returns one row per artifact, newest (highest seq) first', () => {
    const rows = deriveArtifacts([
      artifactEntry(1, 'a1', 'Bristol bus times'),
      artifactEntry(2, 'a2', 'Garden plan'),
    ]);
    expect(rows.map((r) => r.title)).toEqual(['Garden plan', 'Bristol bus times']);
  });

  it('ignores non-artifact entries interleaved with artifacts', () => {
    const rows = deriveArtifacts([
      { seq: 1, kind: 'message', content: 'hi', at: 0 },
      artifactEntry(2, 'a1', 'Bristol bus times'),
      { seq: 3, kind: 'tool_call', tool: 'Read', at: 0 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.artifactId).toBe('a1');
  });
});

describe('mergeArtifacts', () => {
  const row = (id: string, seq: number, title = id) => ({
    artifactId: id,
    title,
    path: `${id}.html`,
    url: `/u/${id}`,
    seq,
  });
  it('adds older artifacts the paged transcript lacks, newest first, transcript winning', () => {
    const rows = mergeArtifacts(
      [row('new', 9, 'Live')],
      [
        { ...row('new', 9), updatedAt: 1 },
        { ...row('old', 2), updatedAt: 1 },
        { ...row('mid', 5), updatedAt: 1 },
      ],
    );
    expect(rows.map((r) => r.artifactId)).toEqual(['new', 'mid', 'old']);
    expect(rows[0]!.title).toBe('Live');
  });
});
