// `bootstrap()` opens the socket BEFORE it awaits the roster, so live frames
// can land first. The roster answer then arrives via `hydrate` and must not
// wipe what only the live stream knows (types.ts: preview, lastVisitedAt,
// pendingPermissions, lastSeq and awaitingPermission are "deliberately not part
// of" the roster row) nor roll a newer `chat.state` back to an older snapshot.

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore, deriveBadge } from '../src/stores/chatStore';
import { toChatListRow } from '../src/lib/chatListRow';
import type { ChatListEntry } from '../src/api/rest';

const ENTRY: ChatListEntry = {
  chatId: 'c1',
  name: 'Chat',
  hostId: 'd1',
  folder: '/f',
  activity: 'idle',
  permissionMode: 'auto',
  status: 'active',
  pinned: false,
  pinnedAt: null,
  lastUpdated: 10,
  pendingWake: null,
  snoozedUntil: null,
};

const chat = () => useChatStore.getState().chats['c1']!;

beforeEach(() => {
  useChatStore.getState()._reset();
  useChatStore.getState().hydrate([toChatListRow(ENTRY)]);
});

describe('hydrate after live frames', () => {
  it('keeps the replay cursor, preview, visit time and pending permission', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.message', chatId: 'c1', seq: 9, role: 'assistant', content: 'hi' });
    s.markRead('c1');
    s.applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      seq: 10,
      requestId: 'r1',
      request: { tool: 'Bash', description: 'ls', args: { command: 'ls' } },
    });
    s.appendLocalUserMessage('c1', 'typed while loading', 'L1');
    const visited = chat().lastVisitedAt;
    expect(visited).toBeGreaterThan(0);

    s.hydrate([toChatListRow(ENTRY)]);

    expect(chat().lastSeq).toBe(10);
    expect(chat().preview).toBe('typed while loading');
    expect(chat().lastVisitedAt).toBe(visited);
    expect(chat().pendingPermissions).toHaveLength(1);
    expect(deriveBadge(chat())).toBe('permission');
  });

  it('does not roll a newer live state back to an older roster snapshot', () => {
    const s = useChatStore.getState();
    s.applyEvent({
      type: 'chat.state',
      chatId: 'c1',
      activity: 'running',
      permissionMode: 'auto',
      lastUpdated: 20,
    } as never);

    s.hydrate([toChatListRow({ ...ENTRY, activity: 'idle', lastUpdated: 10 })]);

    expect(chat().activity).toBe('running');
    expect(chat().lastUpdated).toBe(20);
  });

  it('still lets a NEWER roster answer win over the stored state', () => {
    useChatStore
      .getState()
      .hydrate([toChatListRow({ ...ENTRY, activity: 'running', lastUpdated: 30 })]);
    expect(chat().activity).toBe('running');
    expect(chat().lastUpdated).toBe(30);
  });
});
