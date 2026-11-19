// spec/04 § Provider switches (mobile) — a chat keeps one provider for its
// life. Picking another provider's model in the composer drafts a new chat
// linked to this one and opens it on the new-chat screen; nothing goes to the
// host. A same-provider pick is an ordinary model change, and the Manager
// changes provider in place.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderRN, findHost, byTestId, actSync, actAsync, flush } from './testUtils/render';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { useSettingsStore } from '../src/stores/settingsStore';
import { __resetPreferences } from '../src/lib/preferences';
import { deliveryTracker } from '../src/lib/deliveryTracker';
import { __clearAllMmkv } from './stubs/mmkv';
import { __resetRouterMock, routerMock } from './stubs/expo-router';
import { useNewChatDraftStore } from '../src/stores/newChatDraftStore';

const { modelsSpy, continueChatSpy } = vi.hoisted(() => ({
  modelsSpy: vi.fn(),
  continueChatSpy: vi.fn(),
}));
vi.mock('../src/api/rest', () => ({
  api: {
    skills: vi.fn().mockResolvedValue({ skills: [] }),
    uploadAttachment: vi.fn(),
    models: modelsSpy,
    continueChat: continueChatSpy,
  },
  ApiError: class ApiError extends Error {},
}));

const wsMock = { send: vi.fn(), safeSend: vi.fn(), requestReplay: vi.fn() };
vi.mock('../src/api/ws', () => ({ getWs: () => wsMock }));

import { Composer } from '../src/components/Composer';
import { useComposerDraftStore } from '../src/lib/composerDraft';

const BASE_PREFERENCES = {
  sweepEnabled: true,
  quietHoursStart: '23:00',
  quietHoursEnd: '07:00',
  addressWord: 'patch',
  reach: 'notify' as const,
  defaultModel: 'claude-opus-5',
  specialThreadModel: 'claude-sonnet-5',
  rotationEnabled: true,
  rotationTime: '02:00',
  voiceConfig: {
    dictation: { phone: 'device' as const, computer: 'whisper' as const, tidy: false },
    device: { backend: 'local' as const, layer: 'direct' as const, handoff: 'auto' as const },
    handsFree: { backend: 'local' as const, layer: 'direct' as const, handoff: 'auto' as const },
    call: { backend: 'local' as const, layer: 'direct' as const, handoff: 'auto' as const },
  },
};

function seedSettings(): void {
  useSettingsStore.setState({
    data: {
      devices: [],
      push: { tokenCount: 0 },
      google: { configured: false, connected: false, scope: null },
      preferences: { ...BASE_PREFERENCES },
    },
    error: null,
  });
}

beforeEach(() => {
  __clearAllMmkv();
  useComposerDraftStore.getState()._reset();
  __resetPreferences();
  vi.clearAllMocks();
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
  });
  useChatStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  useSettingsStore.getState()._reset();
  modelsSpy.mockResolvedValue({
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { id: 'openai/gpt-5-codex', label: 'GPT-5 Codex' },
    ],
  });
  __resetRouterMock();
  continueChatSpy.mockResolvedValue({
    draft: {
      id: 'draft-linked-m',
      hostId: 'd1',
      folder: '/home/tom/work',
      model: 'openai/gpt-5-codex',
      text: 'This continues "Chat"',
      continuedFrom: 'c1',
      updatedAt: 1,
    },
  });
  vi.spyOn(deliveryTracker, 'submit').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function seedChat(model = 'claude-opus-5-5', chatId = 'c1'): void {
  useChatStore.getState().hydrate([
    {
      chatId,
      hostId: 'd1',
      name: 'Chat',
      folder: '/home/tom/work',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
      permissionMode: 'default',
      model,
    },
  ]);
}

async function openPickerAndChoose(
  root: ReturnType<typeof renderRN>['root'],
  modelId: string,
): Promise<void> {
  await actAsync(async () => {
    findHost(root, byTestId('composer-model-pill')).props['onPress']();
    await flush();
  });
  actSync(() => findHost(root, byTestId('model-menu-all')).props['onPress']());
  actSync(() => findHost(root, byTestId(`new-chat-model-option-${modelId}`)).props['onPress']());
}

describe('Composer — a provider switch starts a linked chat', () => {
  it('a cross-provider pick drafts a linked chat and opens it, sending nothing to the host', async () => {
    seedSettings();
    seedChat();
    const { root } = renderRN(<Composer chatId="c1" />);
    await openPickerAndChoose(root, 'openai/gpt-5-codex');
    await actAsync(async () => {
      await flush();
    });
    expect(continueChatSpy).toHaveBeenCalledWith('c1', { model: 'openai/gpt-5-codex' });
    expect(routerMock.push).toHaveBeenCalledWith('/new-chat?draftId=draft-linked-m');
    expect(useNewChatDraftStore.getState().get('draft-linked-m')).toMatchObject({
      continuedFrom: 'c1',
    });
    expect(wsMock.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.model_request' }),
    );
  });

  it('says so when the linked chat cannot be drafted', async () => {
    continueChatSpy.mockRejectedValue(new Error('server down'));
    seedSettings();
    seedChat();
    const { root } = renderRN(<Composer chatId="c1" />);
    await openPickerAndChoose(root, 'openai/gpt-5-codex');
    await actAsync(async () => {
      await flush();
    });
    expect(
      useUiStore
        .getState()
        .errors.map((e) => e.message)
        .join(' '),
    ).toContain('Could not start a linked chat: server down');
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it('a same-provider pick is an ordinary model change', async () => {
    seedSettings();
    seedChat();
    const { root } = renderRN(<Composer chatId="c1" />);
    await openPickerAndChoose(root, 'claude-sonnet-5');
    expect(continueChatSpy).not.toHaveBeenCalled();
    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'chat.model_request',
      chatId: 'c1',
      model: 'claude-sonnet-5',
    });
  });

  it('the Manager changes provider in place', async () => {
    seedSettings();
    seedChat('claude-opus-5-5', 'thread_manager');
    const { root } = renderRN(<Composer chatId="thread_manager" />);
    await openPickerAndChoose(root, 'openai/gpt-5-codex');
    expect(continueChatSpy).not.toHaveBeenCalled();
    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'chat.model_request',
      chatId: 'thread_manager',
      model: 'openai/gpt-5-codex',
    });
  });
});
