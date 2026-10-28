// ParentChatBar — chat-detail bar linking a chat another chat launched back to
// that chat (spec/15 § Chat detail → Status bars).

import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { renderRN, findHost, queryHost, byTestId } from './testUtils/render';
import { routerMock } from './stubs/expo-router';
import type { ChatRow } from '../src/stores/types';
import { useChatStore } from '../src/stores/chatStore';
import { ParentChatBar } from '../src/components/chatBars/ParentChatBar';

const row = (parentChatId?: string, chatId = 'c1'): ChatRow =>
  ({ chatId, ...(parentChatId !== undefined ? { parentChatId } : {}) }) as ChatRow;

beforeEach(() => {
  routerMock.push.mockClear();
  useChatStore.setState({ chats: { p1: { chatId: 'p1', name: 'planner' } as ChatRow } });
});

describe('ParentChatBar', () => {
  it('renders nothing for a chat no other chat launched', () => {
    const r = renderRN(<ParentChatBar row={row()} />);
    expect(queryHost(r.root, byTestId('parent-chat-bar'))).toBeNull();
  });

  it('opens the launching chat when tapped', () => {
    const r = renderRN(<ParentChatBar row={row('p1')} />);
    findHost(r.root, byTestId('parent-chat-bar')).props.onPress();
    expect(routerMock.push).toHaveBeenCalledWith('/chats/p1');
  });

  it('names the launching chat', () => {
    const r = renderRN(<ParentChatBar row={row('p1')} />);
    expect(JSON.stringify(r.toJSON())).toContain('Started by \\"planner\\" chat');
  });

  it('still shows when the launching chat is unknown to this device', () => {
    const r = renderRN(<ParentChatBar row={row('gone')} />);
    expect(JSON.stringify(r.toJSON())).toContain('Started by another chat');
  });

  it('hides the bar when dismissed', () => {
    const r = renderRN(<ParentChatBar row={row('p1', 'c_dismiss')} />);
    findHost(r.root, byTestId('parent-chat-bar-dismiss')).props.onPress();
    expect(queryHost(r.root, byTestId('parent-chat-bar'))).toBeNull();
  });
});
