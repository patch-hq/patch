// spec/05 § Chat status — the phone stores the server's status with its copy of
// the chat and shows it. A send, a tool call or a permission card never makes
// it assume one.
import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../src/stores/chatStore';
import { deriveBadge } from '../src/stores/types';

const badge = () => deriveBadge(useChatStore.getState().chats['c1']!);
const state = (s: string, lastUpdated: number) =>
  useChatStore.getState().applyEvent({
    type: 'chat.state',
    chatId: 'c1',
    permissionMode: 'default',
    chatStatus: { state: s, since: lastUpdated },
    lastUpdated,
  });

beforeEach(() => {
  useChatStore.getState()._reset();
  useChatStore
    .getState()
    .applyEvent({ type: 'chat.spawned', hostId: 'd1', chatId: 'c1', folder: '~/p' });
});

describe('the chat status is the server’s', () => {
  it('a send does not read working until the server says so', () => {
    state('idle', 1);
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'l1');
    expect(badge()).not.toBe('working');
    state('running', 2);
    expect(badge()).toBe('working');
  });

  it('a permission card does not make the chat waiting; the server status does', () => {
    state('running', 1);
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      seq: 3,
      requestId: 'r1',
      request: { tool: 'Bash', description: 'ls', args: {} },
    });
    expect(useChatStore.getState().chats['c1']!.chatStatus?.state).toBe('running');
    state('waiting_for_user', 2);
    expect(badge()).toBe('permission');
  });

  it('keeps the whole status the server sent, reason and all', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.state',
      chatId: 'c1',
      permissionMode: 'default',
      chatStatus: { state: 'failed', since: 4, reason: 'sdk_error', message: 'boom' },
      lastUpdated: 4,
    });
    expect(useChatStore.getState().chats['c1']!.chatStatus).toEqual({
      state: 'failed',
      since: 4,
      reason: 'sdk_error',
      message: 'boom',
    });
  });
});
