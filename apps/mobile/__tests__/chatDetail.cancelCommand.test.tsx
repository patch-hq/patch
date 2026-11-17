// app/chats/[chatId].tsx — cancel ONE running Bash command without ending the
// turn (`chat.tool_cancel_request`). Parity with web's ChatRoute.runningTool test.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderRN, findHost, queryHost, byTestId, hasText } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __setLocalSearchParams } from './stubs/expo-router';

const sendMock = vi.fn();
vi.mock('../src/api/ws', () => ({
  getWs: () => ({ send: sendMock, safeSend: vi.fn(), requestReplay: vi.fn() }),
}));
vi.mock('../src/api/rest', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    deleteChat: vi.fn(),
    pinChat: vi.fn(),
  },
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

let ChatDetailScreen: React.ComponentType;

const bashCall = (tool = 'Bash'): void =>
  useChatStore.getState().applyEvent({
    type: 'chat.tool_call',
    chatId: 'c1',
    seq: 1,
    tool,
    args: { command: 'sleep 100' },
    callId: 'call-1',
    startedAt: Date.now(),
  });

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
      activity: 'running',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
    },
  ]);
  __setLocalSearchParams({ chatId: 'c1' });
});

describe('cancel one running command', () => {
  it('sends chat.tool_cancel_request for that call, then shows the chip once it returns as an error', () => {
    bashCall();
    const r = renderRN(<ChatDetailScreen />);
    findHost(r.root, byTestId('tool-cancel')).props.onPress();
    expect(sendMock).toHaveBeenCalledWith({
      type: 'chat.tool_cancel_request',
      chatId: 'c1',
      callId: 'call-1',
    });
    expect(queryHost(r.root, byTestId('tool-cancelled'))).toBeNull();
    useChatStore.getState().applyEvent({
      type: 'chat.tool_result',
      chatId: 'c1',
      tool: 'Bash',
      callId: 'call-1',
      result: 'Exit code 130',
      isError: true,
      seq: 2,
    });
    const r2 = renderRN(<ChatDetailScreen />);
    expect(hasText(r2.root, 'Cancelled by you')).toBe(true);
    expect(queryHost(r2.root, byTestId('tool-cancel'))).toBeNull();
  });

  it('offers no cancel on a non-Bash call', () => {
    bashCall('Read');
    const r = renderRN(<ChatDetailScreen />);
    expect(queryHost(r.root, byTestId('tool-cancel'))).toBeNull();
  });
});
