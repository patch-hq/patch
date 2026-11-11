// app/chats/[chatId].tsx — a `Skill` tool call's row opens that skill's
// SKILL.md in the file editor (mirrors web's SkillToolCall, spec/15 § Chat
// detail). A skill the host cannot point at states why instead of linking.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderRN, findAllHost, byTestId, actAsync, actSync, flush } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __setLocalSearchParams, routerMock } from './stubs/expo-router';

const skillsMock = vi.fn();
vi.mock('../src/api/rest', () => ({
  api: {
    deleteChat: vi.fn(),
    pinChat: vi.fn(),
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    skills: (...a: unknown[]) => skillsMock(...a),
  },
}));
vi.mock('../src/api/ws', () => ({
  getWs: () => ({ send: vi.fn(), safeSend: vi.fn(), requestReplay: vi.fn() }),
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

let ChatDetailScreen: React.ComponentType;

function skillCall(name: string): void {
  useChatStore.getState().applyEvent({
    type: 'chat.tool_call',
    chatId: 'c1',
    seq: 1,
    tool: 'Skill',
    args: { skill: name },
    callId: 's1',
  } as never);
}

beforeEach(async () => {
  vi.clearAllMocks();
  skillsMock.mockReset();
  useChatStore.getState()._reset();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setHost('online');
  ChatDetailScreen = (await import('../app/chats/[chatId]')).default;
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      hostId: 'h1',
      name: 'My Chat',
      folder: '/home/tom/project',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
    },
  ] as never);
  __setLocalSearchParams({ chatId: 'c1' });
});

describe('Skill tool call row', () => {
  it('tapping it opens the skill file in the editor', async () => {
    skillsMock.mockResolvedValue({
      skills: ['buy'],
      paths: { buy: '/home/tom/project/.claude/skills/buy/SKILL.md' },
    });
    skillCall('buy');
    const r = renderRN(<ChatDetailScreen />);
    await actAsync(flush);
    expect(skillsMock).toHaveBeenCalledWith('/home/tom/project', 'h1');
    const link = findAllHost(r.root, byTestId('tool-call-skill-link'));
    expect(link).toHaveLength(1);
    actSync(() => link[0]!.props.onPress());
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/hosts/[hostId]/edit',
      params: { hostId: 'h1', path: '/home/tom/project/.claude/skills/buy/SKILL.md' },
    });
  });

  it('a skill the host does not have says so and is not tappable', async () => {
    skillsMock.mockResolvedValue({ skills: [], paths: {} });
    skillCall('ghost');
    const r = renderRN(<ChatDetailScreen />);
    await actAsync(flush);
    expect(findAllHost(r.root, byTestId('tool-call-skill-link'))).toHaveLength(0);
    expect(findAllHost(r.root, byTestId('tool-call-skill-unavailable'))).toHaveLength(1);
  });

  it('a failed lookup is shown, not hidden', async () => {
    skillsMock.mockRejectedValue(new Error('boom'));
    skillCall('buy');
    const r = renderRN(<ChatDetailScreen />);
    await actAsync(flush);
    const note = findAllHost(r.root, byTestId('tool-call-skill-unavailable'));
    expect(note).toHaveLength(1);
    expect(JSON.stringify(note[0]!.props.children)).toContain('boom');
  });
});
