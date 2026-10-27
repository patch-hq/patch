// A reconnecting host re-announces every chat it holds, archived ones included,
// as `chat.spawned` then `chat.state`, which can land in different batches.
// Until the state lands the row's status is a default, so it is held back
// from the Chats list rather than flashing an archived chat in. As web.

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../src/stores/chatStore';

beforeEach(() => {
  useChatStore.getState()._reset();
});

describe('a re-announced chat this phone has not seen', () => {
  it('waits for its state, then takes the status the state says', () => {
    const s = useChatStore.getState();
    s.applyEvents([{ type: 'chat.spawned', hostId: 'd1', chatId: 'arch', folder: '/f' }]);
    expect(useChatStore.getState().chats['arch']?.awaitingState).toBe(true);
    s.applyEvents([
      {
        type: 'chat.state',
        chatId: 'arch',
        hostId: 'd1',
        folder: '/f',
        activity: 'idle',
        permissionMode: 'auto',
        status: 'archived',
        lastUpdated: 1000,
      } as never,
    ]);
    const row = useChatStore.getState().chats['arch'];
    expect(row?.awaitingState).toBe(false);
    expect(row?.status).toBe('archived');
  });

  it('a chat already held is not held back by its re-announcement', () => {
    const s = useChatStore.getState();
    s.applyEvents([
      { type: 'chat.spawned', hostId: 'd1', chatId: 'k', folder: '/f' },
      {
        type: 'chat.state',
        chatId: 'k',
        hostId: 'd1',
        folder: '/f',
        activity: 'idle',
        permissionMode: 'auto',
        status: 'active',
        lastUpdated: 1000,
      } as never,
    ]);
    s.applyEvents([{ type: 'chat.spawned', hostId: 'd1', chatId: 'k', folder: '/f' }]);
    expect(useChatStore.getState().chats['k']?.awaitingState).toBe(false);
  });
});
