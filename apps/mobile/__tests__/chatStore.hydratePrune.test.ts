// A roster refresh prunes the device copy (spec/05 § Loading): the transcripts
// of chats the server's list no longer names leave the phone, so a chat
// deleted elsewhere does not sit in storage until the 500-chat bound pushes it
// out. A chat the phone has open is kept whatever the list says.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __clearAllMmkv } from './stubs/mmkv';
import { useChatStore } from '../src/stores/chatStore';
import { toChatListRow } from '../src/lib/chatListRow';
import type { ChatListEntry } from '../src/api/rest';
import {
  __resetPendingForTests,
  heldChatIds,
  loadTranscript,
  saveEvents,
} from '../src/lib/transcriptCache';

const entry = (chatId: string): ChatListEntry => ({
  chatId,
  name: chatId,
  hostId: 'd1',
  folder: '/f',
  chatStatus: { state: 'idle', since: 0 },
  permissionMode: 'auto',
  status: 'active',
  pinned: false,
  pinnedAt: null,
  lastUpdated: 10,
  pendingWake: null,
  snoozedUntil: null,
});

function hold(chatId: string): void {
  saveEvents(chatId, [
    { type: 'chat.message', chatId, seq: 1, role: 'assistant', content: `in ${chatId}` },
  ]);
  vi.advanceTimersByTime(1000);
}

beforeEach(() => {
  vi.useFakeTimers();
  __clearAllMmkv();
  __resetPendingForTests();
  useChatStore.getState()._reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('hydrate prunes the device copy', () => {
  it('drops the transcript of a chat the roster no longer lists', () => {
    hold('kept');
    hold('deleted-elsewhere');

    useChatStore.getState().hydrate([toChatListRow(entry('kept'))]);

    expect([...heldChatIds()]).toEqual(['kept']);
    expect(loadTranscript('deleted-elsewhere')).toBeNull();
    expect(loadTranscript('kept')).not.toBeNull();
  });

  it('keeps the chat the phone has open, and any with a timeline in memory', () => {
    hold('open');
    hold('in-memory');
    const s = useChatStore.getState();
    s.setActiveChat('open');
    s.applyEvent({ type: 'chat.message', chatId: 'in-memory', seq: 1, role: 'user', content: 'x' });

    s.hydrate([]);

    expect(heldChatIds()).toEqual(new Set(['open', 'in-memory']));
  });
});
