// Signing out must leave nothing of the account's chats on the device
// (spec/05 § Loading, Device copy): the chat list, every cached transcript and
// the feed position all go with the credential.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import { saveChatList, loadChatList, __resetChatListCacheForTests } from '../lib/chatListCache.js';
import { saveEvents, loadTranscript, __resetCacheForTests } from '../lib/transcriptCache.js';
import { forgetAccountOnDevice } from '../lib/forgetAccountOnDevice.js';
import type { ChatRow } from '../stores/types.js';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  __resetChatListCacheForTests();
  __resetCacheForTests();
  window.localStorage.clear();
});

describe('forgetAccountOnDevice', () => {
  it('clears the credential, chat list, transcripts and feed position', async () => {
    window.localStorage.setItem('patch.feedPos', '42');
    await saveChatList([
      { chatId: 'a', status: 'active', lastUpdated: 1, name: 'a' } as unknown as ChatRow,
    ]);
    await saveEvents('a', [
      { type: 'chat.message', chatId: 'a', seq: 1, role: 'user', content: 'x' },
    ]);
    expect(await loadChatList()).not.toBeNull();
    expect(await loadTranscript('a')).not.toBeNull();

    await forgetAccountOnDevice();

    expect(await loadChatList()).toBeNull();
    expect(await loadTranscript('a')).toBeNull();
    expect(window.localStorage.getItem('patch.feedPos')).toBeNull();
  });
});
