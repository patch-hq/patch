// spec/05 § Chat status — the surface stores the server's status with its copy
// of the chat and shows it. Sending, a tool call or a permission card never
// makes it assume one; the badge moves only when the server says so.

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore, deriveBadge } from '../stores/chatStore.js';

const state = (s: string, lastUpdated = 9e12) => ({
  type: 'chat.state' as const,
  permissionMode: 'bypassPermissions' as const,
  chatId: 'c1',
  chatStatus: { state: s, since: 0 },
  lastUpdated,
});

describe('the chat status is the server’s, stored as sent', () => {
  beforeEach(() => {
    useChatStore.setState({ chats: {}, timelines: {} });
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', hostId: 'd1', chatId: 'c1', folder: '~/p' });
  });

  it('a send does not make the chat look working before the server says so', () => {
    useChatStore.getState().applyEvent(state('idle', 1));
    useChatStore.getState().addLocalMessage('c1', 'hello', 'l1');
    expect(deriveBadge(useChatStore.getState().chats.c1!)).not.toBe('working');
    useChatStore.getState().applyEvent(state('running', 2));
    expect(deriveBadge(useChatStore.getState().chats.c1!)).toBe('working');
  });

  it('a tool call does not make an idle chat working', () => {
    useChatStore.getState().applyEvent(state('idle', 1));
    useChatStore.getState().applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      tool: 'Bash',
      args: {},
      callId: 'k1',
      seq: 3,
    });
    expect(deriveBadge(useChatStore.getState().chats.c1!)).not.toBe('working');
  });

  it('a permission card does not make the chat "needs you"; the server status does', () => {
    useChatStore.getState().applyEvent(state('running', 1));
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r1',
      request: { tool: 'Bash', args: {} },
      seq: 4,
    });
    expect(useChatStore.getState().chats.c1!.chatStatus?.state).toBe('running');
    useChatStore.getState().applyEvent(state('waiting_for_user', 2));
    expect(deriveBadge(useChatStore.getState().chats.c1!)).toBe('permission');
  });

  it('every status the server sends is kept whole, with its reason', () => {
    useChatStore.getState().applyEvent({
      ...state('failed', 3),
      chatStatus: { state: 'failed', since: 7, reason: 'sdk_error', message: 'boom' },
    });
    expect(useChatStore.getState().chats.c1!.chatStatus).toEqual({
      state: 'failed',
      since: 7,
      reason: 'sdk_error',
      message: 'boom',
    });
  });
});
