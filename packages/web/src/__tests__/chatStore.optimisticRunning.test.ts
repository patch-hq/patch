// A send shows the chat as working at once, not after the host's chat.state round trip.

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore, deriveBadge } from '../stores/chatStore.js';

function spawn(): void {
  useChatStore
    .getState()
    .applyEvent({ type: 'chat.spawned', hostId: 'd1', chatId: 'c1', folder: '~/p' });
}

describe('optimistic running on send', () => {
  beforeEach(() => {
    useChatStore.setState({ chats: {}, timelines: {} });
    spawn();
  });

  it('flips an idle chat to working the instant a message is added', () => {
    expect(useChatStore.getState().chats.c1!.activity).toBe('idle');
    useChatStore.getState().addLocalMessage('c1', 'hello', 'l1');
    const row = useChatStore.getState().chats.c1!;
    expect(row.activity).toBe('idle');
    expect(deriveBadge(row)).toBe('working');
  });

  it('puts the previous activity back when delivery fails', () => {
    const s = useChatStore.getState();
    s.addLocalMessage('c1', 'hello', 'l1');
    useChatStore.getState().failDelivery('c1', 'l1');
    expect(deriveBadge(useChatStore.getState().chats.c1!)).not.toBe('working');
  });

  it("hands over to the host's own activity frame", () => {
    useChatStore.getState().addLocalMessage('c1', 'hello', 'l1');
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 9e12,
    });
    expect(deriveBadge(useChatStore.getState().chats.c1!)).not.toBe('working');
  });

  it('does not flip a chat blocked on a permission', () => {
    useChatStore.setState((st) => ({
      chats: { ...st.chats, c1: { ...st.chats.c1!, activity: 'awaiting-permission' } },
    }));
    useChatStore.getState().addLocalMessage('c1', 'hello', 'l1');
    expect(useChatStore.getState().chats.c1!.optimisticSend).toBeFalsy();
  });
});
