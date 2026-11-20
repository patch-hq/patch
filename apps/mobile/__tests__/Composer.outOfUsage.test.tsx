// Composer — Send is never blocked by usage. While every account that could
// run the chat is out of usage the message is queued (the host parks the turn
// until the pool refills) and the Send label says so.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { findHost, byLabel, byType, renderRN, update, flushMicrotasks } from './testUtils/render';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { deliveryTracker } from '../src/lib/deliveryTracker';
import { __clearAllMmkv } from './stubs/mmkv';

vi.mock('../src/lib/hookCheck', async (orig) => ({
  ...(await orig<typeof import('../src/lib/hookCheck')>()),
  checkHooks: async () => ({ decision: 'pass' as const, results: [] }),
}));
vi.mock('../src/api/rest', () => ({
  api: { skills: vi.fn().mockResolvedValue({ skills: [] }), uploadAttachment: vi.fn() },
}));

import { Composer } from '../src/components/Composer';
import { useComposerDraftStore } from '../src/lib/composerDraft';

const FUTURE = Date.now() + 3_600_000;

function report(accounts: { id: string; usage?: Record<string, unknown> }[], hostId = 'd1'): void {
  usePresenceStore.getState().setHostAccount({
    type: 'host.account',
    hostId,
    backendId: 'claude-code',
    connected: true,
    accountEmail: null,
    accounts: accounts.map((a) => ({
      id: a.id,
      label: a.id,
      connected: true,
      accountEmail: null,
      ...(a.usage ? { usage: a.usage } : {}),
    })),
  } as never);
}

const spent = { at: 1, session: { status: 'rejected', utilization: 1, resetsAt: FUTURE } };
const fine = { at: 1, session: { status: 'allowed', utilization: 0.1 } };

let submitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __clearAllMmkv();
  useComposerDraftStore.getState()._reset();
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
    hosts: {},
  });
  useChatStore.getState()._reset();
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      hostId: 'd1',
      name: 'Chat',
      folder: '/work',
      chatStatus: { state: 'idle', since: 0 },
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
      permissionMode: 'default',
      model: 'claude-opus-5-5',
    },
  ]);
  useUiStore.setState({ errors: [] });
  submitSpy = vi.spyOn(deliveryTracker, 'submit').mockImplementation(() => {});
});
afterEach(() => submitSpy.mockRestore());

function typeAndFind() {
  const r = renderRN(<Composer chatId="c1" folder="work" />);
  findHost(r.root, byType('TextInput')).props['onChangeText']('hello');
  update(r, <Composer chatId="c1" folder="work" />);
  return r;
}

describe('Composer — out of usage queues', () => {
  it('keeps Send enabled and submits (queued) when every account is spent', async () => {
    report([
      { id: 'a', usage: spent },
      { id: 'b', usage: spent },
    ]);
    const r = typeAndFind();
    const send = findHost(r.root, byLabel('Send message (queued until usage resets)'));
    expect(send.props['disabled']).toBe(false);
    send.props['onPress']();
    await flushMicrotasks();
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it('still sends while one account has usage left', () => {
    report([
      { id: 'a', usage: spent },
      { id: 'b', usage: fine },
    ]);
    const r = typeAndFind();
    expect(findHost(r.root, byLabel('Send message')).props['disabled']).toBe(false);
  });

  it('does not treat an account with no reading as spent', () => {
    report([{ id: 'a', usage: spent }, { id: 'b' }]);
    const r = typeAndFind();
    expect(findHost(r.root, byLabel('Send message')).props['disabled']).toBe(false);
  });
});
