// The device copy is pruned to the chat list once the sidebar has loaded it
// (spec/05 § Loading, Device copy): a chat deleted elsewhere leaves the
// browser's transcript cache, while the chats this window has open stay.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveEvents,
  loadTranscript,
  pruneTranscripts,
  __resetCacheForTests,
} from '../lib/transcriptCache.js';
import { pruneDeviceCopy } from '../lib/pruneDeviceCopy.js';
import { useChatStore } from '../stores/chatStore.js';
import type { ChatRow } from '../stores/types.js';

const hold = (chatId: string) =>
  saveEvents(chatId, [{ type: 'chat.message', chatId, seq: 1, role: 'user', content: chatId }]);

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  __resetCacheForTests();
  useChatStore.getState()._reset();
});

describe('pruneTranscripts', () => {
  it('drops every cached chat not in the set, and only those', async () => {
    await hold('keep');
    await hold('gone');
    await pruneTranscripts(new Set(['keep']));
    expect(await loadTranscript('gone')).toBeNull();
    expect(await loadTranscript('keep')).not.toBeNull();
  });
});

describe('pruneDeviceCopy', () => {
  it('keeps the listed chats and the open one, and drops a chat deleted elsewhere', async () => {
    await hold('listed');
    await hold('open');
    await hold('deleted-elsewhere');
    useChatStore
      .getState()
      .hydrate([
        {
          chatId: 'listed',
          status: 'active',
          lastUpdated: 1,
          name: 'listed',
        } as unknown as ChatRow,
      ]);
    useChatStore.setState({ activeChatId: 'open' });

    await pruneDeviceCopy();

    expect(await loadTranscript('listed')).not.toBeNull();
    expect(await loadTranscript('open')).not.toBeNull();
    expect(await loadTranscript('deleted-elsewhere')).toBeNull();
  });
});
