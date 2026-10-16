// lib/chatMeta.ts — an optimistic write that is refused must not undo a LATER
// write the server accepted.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { toChatListRow } from '../src/lib/chatListRow';
import { writeGoal, writeReminder, writeTodos } from '../src/lib/chatMeta';
import { api } from '../src/api/rest';

vi.mock('../src/api/rest', () => ({
  api: { setGoal: vi.fn(), setReminder: vi.fn(), setTodos: vi.fn() },
}));

const chat = () => useChatStore.getState().chats['c1']!;

function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: Error): void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.getState()._reset();
  useUiStore.setState({ errors: [] } as never);
  useChatStore.getState().hydrate([
    toChatListRow({
      chatId: 'c1',
      name: 'Chat',
      hostId: 'd1',
      folder: '/f',
      activity: 'idle',
      permissionMode: 'auto',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
      pendingWake: null,
      snoozedUntil: null,
      goal: 'original',
      reminder: 'original',
    }),
  ]);
});

describe('chatMeta optimistic writes', () => {
  it('a goal write refused late does not put back the value a newer accepted write replaced', async () => {
    const first = deferred<unknown>();
    vi.mocked(api.setGoal).mockReturnValueOnce(first.promise as never);
    vi.mocked(api.setGoal).mockResolvedValueOnce(undefined as never);

    const a = writeGoal('c1', 'a');
    await writeGoal('c1', 'b');
    first.reject(new Error('timeout'));
    await a;

    expect(chat().goal).toBe('b');
  });

  it('a reminder write refused late does not put back the value a newer accepted write replaced', async () => {
    const first = deferred<unknown>();
    vi.mocked(api.setReminder).mockReturnValueOnce(first.promise as never);
    vi.mocked(api.setReminder).mockResolvedValueOnce(undefined as never);

    const a = writeReminder('c1', 'a');
    await writeReminder('c1', 'b');
    first.reject(new Error('timeout'));
    await a;

    expect(chat().reminder).toBe('b');
  });

  it('a task-list write refused late does not clobber a newer accepted one', async () => {
    const one = [{ text: 't', status: 'in_progress' as const }];
    const two = [{ text: 't', status: 'completed' as const }];
    const first = deferred<unknown>();
    vi.mocked(api.setTodos).mockReturnValueOnce(first.promise as never);
    vi.mocked(api.setTodos).mockResolvedValueOnce(undefined as never);

    const a = writeTodos('c1', one);
    await writeTodos('c1', two);
    first.reject(new Error('timeout'));
    await a;

    expect(chat().todos).toEqual(two);
  });

  it('a refused write with nothing newer still reverts and says so', async () => {
    vi.mocked(api.setGoal).mockRejectedValueOnce(new Error('no'));
    await writeGoal('c1', 'x');
    expect(chat().goal).toBe('original');
    expect(useUiStore.getState().errors.length).toBe(1);
  });
});
