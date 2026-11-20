// app/chats/[chatId].tsx — a `link_file` call renders a file card, not a
// collapsed tool row (spec/15 § Chat detail; mirrors web's LinkFileCard).

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderRN, findHost, findAllHost, byTestId, textOf } from './testUtils/render';
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
  getWs: () => ({ send: vi.fn(), safeSend: vi.fn(), requestHistory: vi.fn() }),
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

let ChatDetailScreen: React.ComponentType;

function emitLink(result: unknown, tool = 'mcp__patch__link_file'): void {
  useChatStore.getState().applyEvent({
    type: 'chat.tool_call',
    chatId: 'c1',
    seq: 1,
    tool,
    args: { file_path: '/tmp/x.png' },
    callId: 'call-1',
  });
  useChatStore.getState().applyEvent({
    type: 'chat.tool_result',
    chatId: 'c1',
    seq: 2,
    callId: 'call-1',
    result,
  } as never);
}

const ack = {
  kind: 'link',
  name: 'report.docx',
  absPath: '/home/u/report.docx',
  isDirectory: false,
  size: 2048,
};
const block = (v: unknown) => [{ type: 'text', text: JSON.stringify(v) }];

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
      chatStatus: { state: 'idle', since: 0 },
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
    },
  ]);
  __setLocalSearchParams({ chatId: 'c1' });
});

describe('link_file tool row', () => {
  it('shows a card with the name, size and path for a content-block result', () => {
    emitLink(block(ack));
    const r = renderRN(<ChatDetailScreen />);
    const card = findHost(r.root, byTestId('link-file'));
    expect(textOf(card)).toContain('report.docx · 2 KB');
    expect(textOf(card)).toContain('/home/u/report.docx');
  });

  it('also accepts the MCP envelope shape and the bare tool name', () => {
    emitLink({ content: block(ack) }, 'link_file');
    const r = renderRN(<ChatDetailScreen />);
    expect(findAllHost(r.root, byTestId('link-file'))).toHaveLength(1);
  });

  it('falls through to the ordinary row for an error result', () => {
    emitLink(block({ error: 'no such file' }));
    const r = renderRN(<ChatDetailScreen />);
    expect(findAllHost(r.root, byTestId('link-file'))).toHaveLength(0);
  });
});
