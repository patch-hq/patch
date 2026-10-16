import { describe, expect, it } from 'vitest';
import type { ChatEventEntry } from '../stores/chatStore.js';
import { attemptPaging } from './turnAttempts.js';

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
