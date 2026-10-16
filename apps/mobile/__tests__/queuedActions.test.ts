// lib/queuedActions.ts — what saving an edit to a queued message sends.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ChatEventEntry } from '../src/stores/chatStore';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../src/api/ws', () => ({ getWs: () => ({ send }) }));

import { editQueuedMessage } from '../src/lib/queuedActions';
import { useChatStore } from '../src/stores/chatStore';

const queued = (extra: Partial<ChatEventEntry> = {}): ChatEventEntry =>
  ({
    seq: -1,
    kind: 'message',
    role: 'user',
    content: 'later',
    localId: 'L1',
    queued: true,
    at: 0,
    ...extra,
  }) as ChatEventEntry;

beforeEach(() => {
  send.mockReset();
  useChatStore.getState()._reset();
});

describe('editQueuedMessage', () => {
  it('saves new text as an edit', () => {
    editQueuedMessage('c1', queued(), 'sooner');
    expect(send).toHaveBeenCalledWith({
      type: 'chat.edit_queued_request',
      chatId: 'c1',
      localId: 'L1',
      message: 'sooner',
    });
  });

  it.each([[''], ['   '], ['\n'], [' \n\t ']])(
    'emptying it (%j) with nothing attached removes it instead of queueing a blank turn',
    (text) => {
      editQueuedMessage('c1', queued(), text);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith({
        type: 'chat.unqueue_request',
        chatId: 'c1',
        localId: 'L1',
      });
    },
  );

  it('a blank edit keeps a message that still carries attachments', () => {
    const entry = queued({
      attachments: [{ id: 'a', name: 'f', mimeType: 'text/plain', kind: 'document' }],
    });
    editQueuedMessage('c1', entry, '  ');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.edit_queued_request' }),
    );
  });
});
