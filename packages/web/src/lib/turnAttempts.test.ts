import { describe, expect, it } from 'vitest';
import type { ChatEventEntry } from '../stores/chatStore.js';
import { attemptPaging, liveAttemptSelection } from './turnAttempts.js';

const user = (seq: number, attempts?: { seq: number; error?: string }[]): ChatEventEntry =>
  ({
    kind: 'message',
    role: 'user',
    seq,
    content: 'q',
    ...(attempts ? { attempts } : {}),
  }) as ChatEventEntry;
const reply = (seq: number): ChatEventEntry =>
  ({ kind: 'message', role: 'assistant', seq, content: 'a' }) as ChatEventEntry;

describe('attemptPaging', () => {
  const tl = [user(2, [{ seq: 2 }, { seq: 7 }]), reply(3), reply(8), user(10), reply(11)];

  it('shows the settled attempt by default and hides earlier replies', () => {
    const { hidden, pageable } = attemptPaging(tl, new Map());
    expect([...hidden]).toEqual([1]);
    expect(pageable.get(2)).toBe(true);
  });

  it('shows the selected attempt and hides the later one', () => {
    expect([...attemptPaging(tl, new Map([[2, 0]])).hidden]).toEqual([2]);
  });

  it('never touches the next turn', () => {
    expect(attemptPaging(tl, new Map([[2, 0]])).hidden.has(4)).toBe(false);
  });

  it('is not pageable when no attempt left a reply or an error', () => {
    const none = [user(2, [{ seq: 2 }, { seq: 7 }]), reply(8)];
    const { hidden, pageable } = attemptPaging(none, new Map());
    expect(hidden.size).toBe(0);
    expect(pageable.get(2)).toBe(false);
  });
});

describe('liveAttemptSelection', () => {
  const sel = (idx: number, lastSeq: number) => new Map([[2, { idx, lastSeq }]]);

  it('keeps a page while the newest attempt is the one it was made against', () => {
    const tl = [user(2, [{ seq: 2 }, { seq: 7 }]), reply(3), reply(8)];
    expect(liveAttemptSelection(tl, sel(0, 7)).get(2)).toBe(0);
  });

  it('drops the page when the pending retry is echoed as a real attempt', () => {
    const pending = Number.MAX_SAFE_INTEGER;
    const before = [user(2, [{ seq: 2 }, { seq: pending }]), reply(3)];
    expect(liveAttemptSelection(before, sel(0, pending)).get(2)).toBe(0);
    const after = [user(2, [{ seq: 2 }, { seq: 7 }]), reply(3), reply(8)];
    expect(liveAttemptSelection(after, sel(0, pending)).has(2)).toBe(false);
    // …so the newest run is shown again, not hidden behind the old page.
    const paging = attemptPaging(after, liveAttemptSelection(after, sel(0, pending)));
    expect(paging.hidden.has(1)).toBe(true);
    expect(paging.hidden.has(2)).toBe(false);
  });

  it('drops the page when a further retry starts', () => {
    const tl = [user(2, [{ seq: 2 }, { seq: 7 }, { seq: 12 }]), reply(3), reply(8), reply(13)];
    expect(liveAttemptSelection(tl, sel(0, 7)).has(2)).toBe(false);
  });
});
