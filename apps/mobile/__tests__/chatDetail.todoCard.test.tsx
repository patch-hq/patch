// app/chats/[chatId].tsx — a TodoWrite call renders the agent's plan as a
// checklist card, not a folded "Updating the todo list" row (spec/15 § Chat
// detail; mirrors web's TodoCard).

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderRN, findAllHost, byTestId } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __setLocalSearchParams } from './stubs/expo-router';

vi.mock('../src/api/rest', () => ({
  api: {
    deleteChat: vi.fn(),
    pinChat: vi.fn(),
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
  },
}));
vi.mock('../src/api/ws', () => ({
  getWs: () => ({ send: vi.fn(), safeSend: vi.fn(), requestReplay: vi.fn() }),
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

let ChatDetailScreen: React.ComponentType;

const call = (seq: number, tool: string, args: unknown, callId: string) =>
  useChatStore.getState().applyEvent({
    type: 'chat.tool_call',
    chatId: 'c1',
    seq,
    tool,
    args,
    callId,
  } as never);
const result = (seq: number, callId: string) =>
  useChatStore.getState().applyEvent({
    type: 'chat.tool_result',
    chatId: 'c1',
    seq,
    callId,
    result: 'ok',
  } as never);

beforeEach(async () => {
  vi.clearAllMocks();
  useChatStore.getState()._reset();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setHost('online');
  const mod = await import('../app/chats/[chatId]');
  ChatDetailScreen = mod.default;
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      name: 'My Chat',
      folder: '~/project',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
    },
  ]);
  __setLocalSearchParams({ chatId: 'c1' });
});

describe('TodoWrite plan card', () => {
  const todos = [
    { content: 'Diagnose', status: 'completed', activeForm: 'Diagnosing' },
    { content: 'Fix', status: 'in_progress', activeForm: 'Fixing' },
    { content: 'Verify', status: 'pending', activeForm: 'Verifying' },
  ];

  it('draws one item per step with its status, and no second row for the result', () => {
    call(1, 'Bash', { command: 'ls' }, 'b1');
    result(2, 'b1');
    call(3, 'TodoWrite', { todos }, 't1');
    result(4, 't1');
    const r = renderRN(<ChatDetailScreen />);
    expect(findAllHost(r.root, byTestId('todo-card'))).toHaveLength(1);
    const items = findAllHost(r.root, byTestId('todo-card-item'));
    expect(items.map((n) => n.props.accessibilityLabel)).toEqual([
      'Diagnose, completed',
      'Fix, in progress',
      'Verify, pending',
    ]);
    expect(findAllHost(r.root, byTestId('tool-group'))).toHaveLength(0);
  });

  it('an empty list stays an ordinary row', () => {
    call(1, 'TodoWrite', { todos: [] }, 't1');
    const r = renderRN(<ChatDetailScreen />);
    expect(findAllHost(r.root, byTestId('todo-card'))).toHaveLength(0);
  });
});
