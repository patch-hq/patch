// Triage on the phone (spec/14 § Triage): the oldest waiting chat in full, a
// reply box, Send marks it read and moves on; a late finisher joins the end.

import React from 'react';
import { act } from 'react-test-renderer';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderRN, findHost, byTestId, hasText, actAsync, flush } from './testUtils/render';
import TriageScreen from '../app/triage';
import { useChatStore, type ChatEventEntry } from '../src/stores/chatStore';
import type { ChatRow } from '../src/stores/types';

const sent = vi.hoisted(() => [] as { chatId: string; text: string }[]);
const replays = vi.hoisted(() => [] as string[]);
vi.mock('../src/lib/sendQueue', () => ({
  sendMessage: (chatId: string, text: string) => {
    sent.push({ chatId, text });
    return 'local';
  },
}));
vi.mock('../src/api/ws', () => ({
  getWs: () => ({ requestReplay: (id: string) => replays.push(id) }),
}));

const row = (chatId: string, name: string, lastUpdated: number): ChatRow =>
  ({
    chatId,
    hostId: 'd1',
    name,
    preview: null,
    statusKind: null,
    statusDeclared: null,
    todos: [],
    folder: '/w',
    chatStatus: { state: 'idle', since: 0 },
    status: 'active',
    pinned: false,
    disabled: false,
    lastUpdated,
    lastSeq: 5,
    lastReadSeq: 1,
    pendingPermissions: [],
  }) as unknown as ChatRow;
const msg = (content: string): ChatEventEntry[] => [
  { kind: 'message', role: 'assistant', content, seq: 3 } as ChatEventEntry,
];

type R = ReturnType<typeof renderRN>;
const mounted: R[] = [];
const get = (r: R, id: string) => findHost(r.root, byTestId(id));
const type = async (r: R, text: string) => {
  await actAsync(() => get(r, 'triage-input').props['onChangeText'](text));
};
const press = async (r: R, id: string) => {
  await actAsync(() => get(r, id).props['onPress']());
  await flush();
};

beforeEach(() => {
  sent.length = 0;
  replays.length = 0;
  useChatStore.getState()._reset();
  useChatStore.setState({
    chats: { a: row('a', 'first chat', 10), b: row('b', 'second chat', 20) },
    timelines: { a: msg('Message from A'), b: msg('Message from B') },
  });
});
afterEach(() => {
  for (const r of mounted.splice(0)) act(() => r.unmount());
});

describe('Triage screen', () => {
  it('shows the oldest waiting chat in full and asks for its transcript', async () => {
    const r = renderRN(<TriageScreen />);
    mounted.push(r);
    await flush();
    expect(hasText(get(r, 'triage-title'), 'first chat')).toBe(true);
    expect(hasText(get(r, 'triage-card'), 'Message from A')).toBe(true);
    expect(hasText(get(r, 'triage-count'), '2 waiting')).toBe(true);
    expect(replays).toContain('a');
  });

  it('sends the reply, marks read, moves on; a late finisher goes last; ends empty', async () => {
    const r = renderRN(<TriageScreen />);
    mounted.push(r);
    await flush();
    await actAsync(() => {
      useChatStore.setState({
        chats: { ...useChatStore.getState().chats, c: row('c', 'third chat', 30) },
        timelines: { ...useChatStore.getState().timelines, c: msg('Message from C') },
      });
    });
    expect(hasText(get(r, 'triage-count'), '3 waiting')).toBe(true);
    for (const name of ['second chat', 'third chat']) {
      await type(r, 'go ahead');
      await press(r, 'triage-send');
      expect(hasText(get(r, 'triage-title'), name)).toBe(true);
    }
    await type(r, 'last');
    await press(r, 'triage-send');
    expect(sent.map((s) => s.chatId)).toEqual(['a', 'b', 'c']);
    expect(useChatStore.getState().chats['a']!.lastReadSeq).toBe(5);
    expect(get(r, 'triage-empty')).toBeTruthy();
  });

  it('does not send an empty reply', async () => {
    const r = renderRN(<TriageScreen />);
    mounted.push(r);
    await flush();
    expect(get(r, 'triage-send').props['disabled']).toBe(true);
    expect(sent).toEqual([]);
  });
});
