import { describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../src/stores/chatStore';
import { navigateAfterSnooze } from '../src/lib/snoozeNav';
import type { ChatRow } from '../src/stores/types';

function row(chatId: string, lastUserActivity: number): ChatRow {
  return {
    chatId,
    folder: '/p',
    status: 'active',
    pinned: false,
    snoozedUntil: null,
    lastUserActivity,
    lastUpdated: lastUserActivity,
  } as unknown as ChatRow;
}

function nav() {
  return { replace: vi.fn(), dismissTo: vi.fn() };
}

function seed(active: string | null): void {
  useChatStore.setState({
    chats: { a: row('a', 3), b: row('b', 2), c: row('c', 1) },
    activeChatId: active,
  } as never);
}

describe('navigateAfterSnooze', () => {
  it('moves to the next chat in order', () => {
    seed('a');
    const n = nav();
    navigateAfterSnooze(['a'], n);
    expect(n.replace).toHaveBeenCalledWith('/chats/b');
  });

  it('falls back to the previous chat at the end of the list', () => {
    seed('c');
    const n = nav();
    navigateAfterSnooze(['c'], n);
    expect(n.replace).toHaveBeenCalledWith('/chats/b');
  });

  it('skips neighbours snoozed in the same project snooze', () => {
    seed('a');
    const n = nav();
    navigateAfterSnooze(['a', 'b'], n);
    expect(n.replace).toHaveBeenCalledWith('/chats/c');
  });

  it('goes to the Chats tab when nothing is left', () => {
    seed('a');
    const n = nav();
    navigateAfterSnooze(['a', 'b', 'c'], n);
    expect(n.replace).not.toHaveBeenCalled();
    expect(n.dismissTo).toHaveBeenCalledWith('/(tabs)/chats');
  });

  it('does nothing when the open chat is not being snoozed', () => {
    seed('a');
    const n = nav();
    navigateAfterSnooze(['b'], n);
    navigateAfterSnooze(['a'], { replace: vi.fn(), dismissTo: vi.fn() });
    expect(n.replace).not.toHaveBeenCalled();
    expect(n.dismissTo).not.toHaveBeenCalled();
    seed(null);
    navigateAfterSnooze(['a'], n);
    expect(n.replace).not.toHaveBeenCalled();
  });
});
