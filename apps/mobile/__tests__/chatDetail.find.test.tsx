// app/chats/[chatId].tsx — find in this chat (spec/15 § Find in chat); harness as jumpTo.
//
// (original header follows)
// app/chats/[chatId].tsx — opening a chat at a search hit (spec/03 § Chat
// search): the route's `seq` param names the matched message, and the
// transcript lands on the row holding it — mid-screen, following off, the
// scroll-to-bottom button up, the row tinted for a moment. Observed through
// the FlatList stub's call log (__flatListCalls), as chatDetail.scroll does;
// every test uses its own chatId because the screen's scroll memory is a
// module-level map that outlives a test.
//
// The list is INVERTED: data is newest-first, so the row index a jump asks for
// counts back from the newest message.

import React from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  renderRN,
  findHost,
  queryHost,
  byTestId,
  textOf,
  actSync,
  actAsync,
} from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __flatListCalls, __resetFlatListCalls } from './stubs/react-native';
import { __setLocalSearchParams } from './stubs/expo-router';

vi.mock('../src/api/rest', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    deleteChat: vi.fn(),
    pinChat: vi.fn(),
  },
}));
vi.mock('../src/api/ws', () => ({
  getWs: () => ({ send: vi.fn(), safeSend: vi.fn(), requestReplay: vi.fn() }),
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

let ChatDetailScreen: React.ComponentType;

const mounted: ReactTestRenderer[] = [];
function render(element: React.ReactElement): ReactTestRenderer {
  const r = renderRN(element);
  mounted.push(r);
  return r;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.clearAllMocks();
  __resetFlatListCalls();
  useChatStore.getState()._reset();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setHost('online');
  const mod = await import('../app/chats/[chatId]');
  ChatDetailScreen = mod.default;
});

afterEach(() => {
  actSync(() => {
    for (const r of mounted.splice(0)) r.unmount();
  });
  vi.useRealTimers();
});

/** Let the FlatList stub's microtask-fired `onContentSizeChange` land. */
async function flushMicro(): Promise<void> {
  await actAsync(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function seedChat(chatId: string): void {
  useChatStore.getState().hydrate([
    {
      chatId,
      name: 'Chat',
      folder: '~/a',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
    },
  ]);
}

function message(chatId: string, seq: number): void {
  useChatStore.getState().applyEvent({
    type: 'chat.message',
    chatId,
    seq,
    role: 'assistant',
    content: `msg ${seq}`,
  });
}

function jumps(): Array<{ index: number; viewPosition?: number; animated?: boolean }> {
  return __flatListCalls
    .filter((c) => c.method === 'scrollToIndex')
    .map((c) => c.args[0] as { index: number; viewPosition?: number; animated?: boolean });
}

describe('find in chat', () => {
  it('opens from the header, counts matches, and steps to each by jumping', async () => {
    seedChat('find-1');
    for (let s = 1; s <= 5; s++) message('find-1', s);
    __setLocalSearchParams({ chatId: 'find-1' });
    const r = render(<ChatDetailScreen />);
    await flushMicro();
    expect(queryHost(r.root, byTestId('chat-find-bar'))).toBeNull();

    await actAsync(async () => {
      findHost(r.root, byTestId('chat-find-toggle')).props.onPress();
    });
    __resetFlatListCalls();
    await actAsync(async () => {
      findHost(r.root, byTestId('chat-find-input')).props.onChangeText('MSG');
    });
    await flushMicro();
    expect(textOf(findHost(r.root, byTestId('chat-find-count')))).toBe('1/5');
    // First match is seq 1: the oldest, so the last index of the newest-first list.
    expect(jumps().at(-1)).toEqual({ index: 4, viewPosition: 0.5, animated: false });

    await actAsync(async () => {
      findHost(r.root, byTestId('chat-find-next')).props.onPress();
    });
    await flushMicro();
    expect(textOf(findHost(r.root, byTestId('chat-find-count')))).toBe('2/5');
    expect(jumps().at(-1)).toEqual({ index: 3, viewPosition: 0.5, animated: false });

    await actAsync(async () => {
      findHost(r.root, byTestId('chat-find-prev')).props.onPress();
      findHost(r.root, byTestId('chat-find-prev')).props.onPress();
    });
    await flushMicro();
    expect(textOf(findHost(r.root, byTestId('chat-find-count')))).toBe('5/5');

    await actAsync(async () => {
      findHost(r.root, byTestId('chat-find-input')).props.onChangeText('nothing');
    });
    expect(textOf(findHost(r.root, byTestId('chat-find-count')))).toBe('0');

    await actAsync(async () => {
      findHost(r.root, byTestId('chat-find-close')).props.onPress();
    });
    expect(queryHost(r.root, byTestId('chat-find-bar'))).toBeNull();
  });

  it('steps back to a lone match after scrolling away (the index does not change)', async () => {
    seedChat('find-2');
    message('find-2', 1);
    message('find-2', 2);
    message('find-2', 3);
    __setLocalSearchParams({ chatId: 'find-2' });
    const r = render(<ChatDetailScreen />);
    await flushMicro();
    await actAsync(async () => {
      findHost(r.root, byTestId('chat-find-toggle')).props.onPress();
    });
    await actAsync(async () => {
      findHost(r.root, byTestId('chat-find-input')).props.onChangeText('msg 2');
    });
    await flushMicro();
    expect(textOf(findHost(r.root, byTestId('chat-find-count')))).toBe('1/1');
    expect(jumps().at(-1)).toMatchObject({ index: 1 });

    __resetFlatListCalls();
    await actAsync(async () => {
      findHost(r.root, byTestId('chat-find-next')).props.onPress();
    });
    await flushMicro();
    expect(jumps().at(-1)).toMatchObject({ index: 1 });
  });

  it('jumps to the new match when the query changes to another single match', async () => {
    seedChat('find-3');
    message('find-3', 1);
    message('find-3', 2);
    __setLocalSearchParams({ chatId: 'find-3' });
    const r = render(<ChatDetailScreen />);
    await flushMicro();
    await actAsync(async () => {
      findHost(r.root, byTestId('chat-find-toggle')).props.onPress();
    });
    await actAsync(async () => {
      findHost(r.root, byTestId('chat-find-input')).props.onChangeText('msg 1');
    });
    await flushMicro();
    expect(jumps().at(-1)).toMatchObject({ index: 1 });

    __resetFlatListCalls();
    await actAsync(async () => {
      findHost(r.root, byTestId('chat-find-input')).props.onChangeText('msg 2');
    });
    await flushMicro();
    expect(jumps().at(-1)).toMatchObject({ index: 0 });
  });

  it('a new matching message arriving does not drag the view back to the current match', async () => {
    seedChat('find-4');
    message('find-4', 1);
    message('find-4', 2);
    __setLocalSearchParams({ chatId: 'find-4' });
    const r = render(<ChatDetailScreen />);
    await flushMicro();
    await actAsync(async () => {
      findHost(r.root, byTestId('chat-find-toggle')).props.onPress();
    });
    await actAsync(async () => {
      findHost(r.root, byTestId('chat-find-input')).props.onChangeText('msg');
    });
    await flushMicro();
    __resetFlatListCalls();
    await actAsync(async () => {
      message('find-4', 3);
    });
    await flushMicro();
    expect(jumps()).toEqual([]);
    expect(textOf(findHost(r.root, byTestId('chat-find-count')))).toBe('1/3');
  });
});
