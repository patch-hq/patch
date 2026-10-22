// A send shows the chat as working at once, not after the host's chat.state round trip.
import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../src/stores/chatStore';
import { deriveBadge } from '../src/stores/types';

const badge = () => deriveBadge(useChatStore.getState().chats['c1']!);

beforeEach(() => {
  useChatStore.getState()._reset();
  useChatStore
    .getState()
    .applyEvent({ type: 'chat.spawned', hostId: 'd1', chatId: 'c1', folder: '~/p' });
});

describe('mobile optimistic send', () => {
  it('reads working the instant a message is sent', () => {
    expect(badge()).not.toBe('working');
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'l1');
    expect(badge()).toBe('working');
  });

  it('stops reading working when delivery fails', () => {
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'l1');
    useChatStore.getState().failDelivery('c1', 'l1');
    expect(badge()).not.toBe('working');
  });

  it("hands over to the host's chat.state", () => {
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'l1');
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 9e12,
    } as never);
    expect(badge()).not.toBe('working');
  });
});
