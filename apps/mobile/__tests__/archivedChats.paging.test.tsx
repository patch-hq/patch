// The Archived section pages its list (spec/14 § Sidebar item 6, same as web):
// one page on open, the next only when the list is scrolled near its end, and
// every page at once only while a search needs the whole set.

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderRN, actAsync, flushMicrotasks } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';

const { listArchivedSpy } = vi.hoisted(() => ({ listArchivedSpy: vi.fn() }));
vi.mock('../src/api/rest', () => ({ api: { listArchivedChats: listArchivedSpy } }));

import { useArchivedChats, ARCHIVED_PAGE_SIZE } from '../src/lib/archivedChats';
import { useUiStore } from '../src/stores/uiStore';

function entry(i: number) {
  return {
    chatId: `a${i}`,
    name: `chat ${i}`,
    preview: null,
    hostId: 'h',
    permissionMode: 'default',
    folder: '/f',
    chatStatus: { state: 'idle', since: 0 },
    status: 'archived',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 1000 - i,
    jobId: null,
    statusSummary: null,
    statusKind: null,
  };
}

// 70 archived chats served 30 at a time. The cursor is opaque to the client;
// this stub uses the last chat id it returned.
function serve(opts: { limit: number; cursor?: string }) {
  const all = Array.from({ length: 70 }, (_, i) => entry(i));
  const start = opts.cursor === undefined ? 0 : all.findIndex((c) => c.chatId === opts.cursor) + 1;
  const chats = all.slice(start, start + opts.limit);
  const end = start + chats.length;
  const last = chats[chats.length - 1];
  return Promise.resolve({
    chats,
    nextCursor: end < all.length && last !== undefined ? last.chatId : null,
  });
}

let loadMore: () => void = () => {};
function Probe({ wanted, all }: { wanted: boolean; all: boolean }): null {
  loadMore = useArchivedChats(wanted, all).loadMore;
  return null;
}

const count = () => Object.keys(useChatStore.getState().chats).length;

describe('useArchivedChats paging', () => {
  beforeEach(() => {
    listArchivedSpy.mockReset().mockImplementation(serve);
    useChatStore.setState({ chats: {} });
  });

  it('fetches one page on open, not the whole list', async () => {
    renderRN(<Probe wanted all={false} />);
    await actAsync(flushMicrotasks);
    expect(listArchivedSpy).toHaveBeenCalledTimes(1);
    expect(listArchivedSpy).toHaveBeenCalledWith({ limit: ARCHIVED_PAGE_SIZE });
    expect(count()).toBe(30);
  });

  it('loads the next page on loadMore and stops at the end', async () => {
    renderRN(<Probe wanted all={false} />);
    await actAsync(flushMicrotasks);
    await actAsync(async () => {
      loadMore();
      await flushMicrotasks();
    });
    expect(count()).toBe(60);
    await actAsync(async () => {
      loadMore();
      await flushMicrotasks();
    });
    expect(count()).toBe(70);
    await actAsync(async () => {
      loadMore();
      await flushMicrotasks();
    });
    expect(listArchivedSpy).toHaveBeenCalledTimes(3);
  });

  it('pulls every page when a search needs the whole set', async () => {
    renderRN(<Probe wanted all />);
    await actAsync(async () => {
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(count()).toBe(70);
  });

  it('pages a server released before the cursor by offset', async () => {
    listArchivedSpy.mockImplementation((opts: { limit: number; offset?: number }) => {
      const all = Array.from({ length: 70 }, (_, i) => entry(i));
      const start = opts.offset ?? 0;
      const chats = all.slice(start, start + opts.limit);
      const end = start + chats.length;
      return Promise.resolve({ chats, nextOffset: end < all.length ? end : null });
    });
    renderRN(<Probe wanted all />);
    await actAsync(async () => {
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(count()).toBe(70);
    expect(listArchivedSpy.mock.calls.map((c) => (c[0] as { offset?: number }).offset)).toEqual([
      undefined,
      30,
      60,
    ]);
  });

  it('stops with an error, rather than starting over, when a page says nothing about the next', async () => {
    useUiStore.setState({ errors: [] });
    listArchivedSpy.mockResolvedValue({ chats: [entry(0)] });
    renderRN(<Probe wanted all />);
    await actAsync(async () => {
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(listArchivedSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(useUiStore.getState().errors)).toContain(
      'the server said nothing about a next page',
    );
  });
});
