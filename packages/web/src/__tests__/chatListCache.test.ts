// The device copy of the chat list (spec/05 § Loading, "Device copy").
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadChatList,
  saveChatList,
  clearChatList,
  __resetChatListCacheForTests,
} from '../lib/chatListCache.js';
import type { ChatRow } from '../stores/types.js';

const row = (chatId: string, over: Partial<ChatRow> = {}): ChatRow =>
  ({
    chatId,
    name: chatId,
    hostId: 'h',
    folder: 'f',
    status: 'active',
    activity: 'idle',
    lastUpdated: 1,
    ...over,
  }) as ChatRow;

beforeEach(() => {
  // A fresh database each test: the module's open handle is dropped with it.
  globalThis.indexedDB = new IDBFactory();
  __resetChatListCacheForTests();
});

describe('chatListCache', () => {
  it('holds nothing until something is saved', async () => {
    expect(await loadChatList()).toBeNull();
  });

  it('round-trips rows with their statuses', async () => {
    await saveChatList([row('a', { chatStatus: { kind: 'interrupted' } } as never), row('b')]);
    const got = await loadChatList();
    expect(got?.map((r) => r.chatId)).toEqual(['a', 'b']);
    expect((got?.[0] as unknown as { chatStatus: unknown }).chatStatus).toEqual({
      kind: 'interrupted',
    });
  });

  it('replaces the previous copy wholesale, so a chat gone from the server does not survive', async () => {
    await saveChatList([row('a'), row('b')]);
    await saveChatList([row('b')]);
    expect((await loadChatList())?.map((r) => r.chatId)).toEqual(['b']);
  });

  it('keeps only active rows, newest first, bounded', async () => {
    const rows = [
      row('old', { lastUpdated: 1 }),
      row('arch', { status: 'archived', lastUpdated: 9 }),
      row('del', { status: 'deleted', lastUpdated: 9 }),
      row('new', { lastUpdated: 5 }),
    ];
    await saveChatList(rows);
    expect((await loadChatList())?.map((r) => r.chatId)).toEqual(['new', 'old']);
  });

  it('can be cleared', async () => {
    await saveChatList([row('a')]);
    await clearChatList();
    expect(await loadChatList()).toBeNull();
  });
});
