// loadSnoozedChats pages the Snoozed list by position until the server says
// nothing is left (spec/01 § GET /api/chats).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '../api/rest.js';
import { loadSnoozedChats } from '../lib/snoozedRows.js';
import { useChatStore } from '../stores/chatStore.js';

const row = (chatId: string) => ({
  chatId,
  hostId: 'h1',
  permissionMode: 'default',
  name: chatId,
  folder: 'f',
  chatStatus: { state: 'idle', since: 0 },
  status: 'active',
  pinned: false,
  pinnedAt: null,
  snoozedUntil: 9_999_999_999_999,
  hidden: false,
  lastUpdated: 1,
  lastUserActivity: 1,
  jobId: null,
});

beforeEach(() => {
  vi.restoreAllMocks();
  useChatStore.getState()._reset();
});

describe('loadSnoozedChats', () => {
  it('follows each page’s cursor until there is none', async () => {
    const spy = vi
      .spyOn(api, 'listChatsSnoozed')
      .mockResolvedValueOnce({ chats: [row('s1')], nextCursor: 'after-s1' })
      .mockResolvedValueOnce({ chats: [row('s2')], nextCursor: null });
    await loadSnoozedChats();
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      { limit: 200 },
      { limit: 200, cursor: 'after-s1' },
    ]);
    expect(Object.keys(useChatStore.getState().chats).sort()).toEqual(['s1', 's2']);
  });

  it('fails, rather than starting over, when a page says nothing about the next', async () => {
    const spy = vi
      .spyOn(api, 'listChatsSnoozed')
      .mockResolvedValue({ chats: [row('s1')] } as never);
    await expect(loadSnoozedChats()).rejects.toThrow('said nothing about a next page');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
