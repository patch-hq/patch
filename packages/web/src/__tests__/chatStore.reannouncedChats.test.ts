// A host re-announces every chat it holds when its link (re)connects, archived
// and hidden ones included: `chat.spawned`, then `chat.state`. The two can land
// in different store batches. Between them the row's status is a default, so
// the sidebar must not draw it — an archived chat flashed into the active list
// and straight back out on every server restart or host reload.
import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../stores/chatStore.js';
import { groupChats } from '../lib/chatGroups.js';

const drawn = (): string[] => {
  const g = groupChats(Object.values(useChatStore.getState().chats));
  return [...g.pinned, ...g.folders.flatMap((f) => f.rows), ...g.archived, ...g.hidden].map(
    (c) => c.chatId,
  );
};

function state(chatId: string, extra: Record<string, unknown> = {}): never {
  return {
    type: 'chat.state',
    chatId,
    hostId: 'd1',
    folder: '/tmp/p',
    chatStatus: { state: 'idle', since: 0 },
    permissionMode: 'auto',
    lastUpdated: 1000,
    ...extra,
  } as never;
}

describe('a re-announced chat this surface has not seen', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useChatStore.getState().hydrate([]);
  });

  it('is not drawn between its chat.spawned and its chat.state', () => {
    const s = useChatStore.getState();
    s.applyEvents([{ type: 'chat.spawned', hostId: 'd1', chatId: 'arch', folder: '/tmp/p' }]);
    expect(useChatStore.getState().chats['arch']).toBeDefined();
    expect(drawn()).toEqual([]);
    s.applyEvents([state('arch', { status: 'archived' })]);
    const g = groupChats(Object.values(useChatStore.getState().chats));
    expect(g.archived.map((c) => c.chatId)).toEqual(['arch']);
    expect(g.folders).toEqual([]);
  });

  it('a genuinely new chat is drawn once its first state lands', () => {
    const s = useChatStore.getState();
    s.applyEvents([{ type: 'chat.spawned', hostId: 'd1', chatId: 'new', folder: '/tmp/p' }]);
    s.applyEvents([state('new', { status: 'active' })]);
    expect(drawn()).toEqual(['new']);
  });

  it('a chat already in the list stays drawn through its re-announcement', () => {
    const s = useChatStore.getState();
    s.applyEvents([
      { type: 'chat.spawned', hostId: 'd1', chatId: 'known', folder: '/tmp/p' },
      state('known', { status: 'active' }),
    ]);
    s.applyEvents([{ type: 'chat.spawned', hostId: 'd1', chatId: 'known', folder: '/tmp/p' }]);
    expect(drawn()).toEqual(['known']);
  });

  it('a snapshot row settles it', () => {
    const s = useChatStore.getState();
    s.applyEvents([{ type: 'chat.spawned', hostId: 'd1', chatId: 'snap', folder: '/tmp/p' }]);
    s.mergeChats([
      {
        chatId: 'snap',
        hostId: 'd1',
        permissionMode: 'auto',
        name: 'snap',
        folder: '/tmp/p',
        chatStatus: { state: 'idle', since: 0 },
        status: 'archived',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 1000,
        jobId: null,
      } as never,
    ]);
    expect(drawn()).toEqual(['snap']);
  });
});

// A chat unarchived on another device: the server's index sends its entry
// (with its feed position) to every device, and that alone puts it back in the
// list here. A frame without one — a host's replay — still creates nothing.
describe('a chat the server’s index names that this surface does not list', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useChatStore.getState().hydrate([]);
  });

  it('is drawn when the index says it is active again', () => {
    useChatStore.getState().applyEvents([state('back', { status: 'active', feedPos: 4 })]);
    expect(drawn()).toEqual(['back']);
  });

  it('is not drawn from a frame without a feed position, nor one saying it is archived', () => {
    useChatStore
      .getState()
      .applyEvents([
        state('replayed', { status: 'active' }),
        state('archived', { status: 'archived', feedPos: 5 }),
      ]);
    expect(useChatStore.getState().chats['replayed']).toBeUndefined();
    expect(useChatStore.getState().chats['archived']).toBeUndefined();
  });
});
