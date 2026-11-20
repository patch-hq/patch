import { describe, it, expect } from 'vitest';
import { branchPointsOf } from '../src/lib/branchPoints';
import type { ChatEventEntry } from '../src/stores/chatStore';

const msg = (
  seq: number,
  role: 'user' | 'assistant',
  extra: Partial<ChatEventEntry> = {},
): ChatEventEntry => ({ seq, kind: 'message', role, content: `m${seq}`, at: 0, ...extra });

describe('branchPointsOf (spec/04 § Forking)', () => {
  it('offers edit and side thread where the entries carry provider ids', () => {
    const points = branchPointsOf(
      [
        msg(1, 'user', { branchable: true }),
        msg(2, 'assistant', { branchable: true }),
        msg(3, 'user', { branchable: true }),
      ],
      'claude-opus-5',
    );
    expect(points.get(1)).toEqual({ edit: true, side: true });
    expect(points.get(2)).toEqual({ edit: false, side: true });
    expect(points.get(3)).toEqual({ edit: true, side: true });
  });

  it('offers nothing on older entries recorded without one, except editing the first turn', () => {
    const points = branchPointsOf(
      [msg(1, 'user'), msg(2, 'assistant'), msg(3, 'user')],
      'claude-opus-5',
    );
    expect(points.get(1)).toEqual({ edit: true, side: false });
    expect(points.get(2)).toEqual({ edit: false, side: false });
    expect(points.get(3)).toEqual({ edit: false, side: false });
  });

  it('leaves out a message still on its way', () => {
    const points = branchPointsOf([msg(1, 'user', { localId: 'L1' })], 'claude-opus-5');
    expect(points.has(1)).toBe(false);
  });
});
