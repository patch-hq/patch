// Composer — built-in slash commands run instead of sending a chat turn
// (spec/04 § Goals, § Model; web parity).
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { findHost, byLabel, byType, renderRN, update, flushMicrotasks } from './testUtils/render';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { deliveryTracker } from '../src/lib/deliveryTracker';
import { useComposerDraftStore } from '../src/lib/composerDraft';
import { __clearAllMmkv } from './stubs/mmkv';
import { api } from '../src/api/rest';

vi.mock('../src/lib/hookCheck', async (orig) => ({
  ...(await orig<typeof import('../src/lib/hookCheck')>()),
  checkHooks: async () => ({ decision: 'pass' as const, results: [] }),
}));
vi.mock('../src/api/rest', () => ({
  api: {
    skills: vi.fn().mockResolvedValue({ skills: [] }),
    uploadAttachment: vi.fn(),
    setGoal: vi.fn().mockResolvedValue({}),
    setReminder: vi.fn().mockResolvedValue({}),
    setLoop: vi.fn().mockResolvedValue({}),
    models: vi.fn().mockResolvedValue({ models: [] }),
  },
}));

import { Composer } from '../src/components/Composer';

let submitSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  __clearAllMmkv();
  useComposerDraftStore.getState()._reset();
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
  });
  useChatStore.getState()._reset();
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      name: 'x',
      folder: 'work',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
    },
  ]);
  useUiStore.setState({ errors: [] });
  submitSpy = vi.spyOn(deliveryTracker, 'submit').mockImplementation(() => {});
  vi.mocked(api.setGoal).mockClear();
  vi.mocked(api.setLoop).mockClear();
});
afterEach(() => submitSpy.mockRestore());

async function send(text: string) {
  const r = renderRN(<Composer chatId="c1" folder="work" />);
  findHost(r.root, byType('TextInput')).props['onChangeText'](text);
  update(r, <Composer chatId="c1" folder="work" />);
  findHost(r.root, byLabel('Send message')).props['onPress']();
  await flushMicrotasks();
  update(r, <Composer chatId="c1" folder="work" />);
  return r;
}

describe('Composer slash commands', () => {
  it('/clear empties the visible transcript, sends nothing and clears the draft', async () => {
    useChatStore.getState().appendLocalUserMessage('c1', 'earlier', 'm-0');
    const r = await send('/clear');
    expect(useChatStore.getState().timelines['c1'] ?? []).toHaveLength(0);
    expect(submitSpy).not.toHaveBeenCalled();
    expect(findHost(r.root, byType('TextInput')).props['value']).toBe('');
  });

  it('/goal <text> sets the goal and sends the text as the turn', async () => {
    await send('/goal tidy the notes');
    expect(api.setGoal).toHaveBeenCalledWith('c1', 'tidy the notes');
    expect(useChatStore.getState().chats['c1']!.goal).toBe('tidy the notes');
    expect(submitSpy).toHaveBeenCalledTimes(1);
    const msg = (useChatStore.getState().timelines['c1'] ?? []).find((e) => e.kind === 'message');
    expect(msg?.content).toBe('tidy the notes');
  });

  it('/loop arms a loop and sends nothing', async () => {
    await send('/loop 5m check');
    expect(api.setLoop).toHaveBeenCalledWith('c1', { every: '5m', message: 'check' });
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('an unknown or malformed command still reaches the agent as text', async () => {
    await send('/plan-travel to Leeds');
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });
});
