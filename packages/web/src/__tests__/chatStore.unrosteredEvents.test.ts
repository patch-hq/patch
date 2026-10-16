// After a restart the host replays events for chats the account no longer
// has. Once the roster is known, none of them may draw an empty "New chat" row.
import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../stores/chatStore.js';

describe('events for a chat outside the roster', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useChatStore.getState().hydrate([]);
  });

  it.each([
    [
      'chat.message',
      { type: 'chat.message', chatId: 'ghost', role: 'assistant', content: 'hi', seq: 1 },
    ],
    [
      'chat.tool_call',
      { type: 'chat.tool_call', chatId: 'ghost', callId: 'c1', name: 'Bash', input: {}, seq: 2 },
    ],
    ['chat.queued', { type: 'chat.queued', chatId: 'ghost', localId: 'l1', content: 'x', seq: 3 }],
    ['chat.stopped', { type: 'chat.stopped', chatId: 'ghost', seq: 4 }],
  ])('%s does not create a row', (_n, ev) => {
    useChatStore.getState().applyEvent(ev as never);
    expect(useChatStore.getState().chats['ghost']).toBeUndefined();
  });

  it('chat.spawned still creates one', () => {
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', hostId: 'd1', chatId: 'real', folder: '~/p' });
    expect(useChatStore.getState().chats['real']).toBeDefined();
  });
});
