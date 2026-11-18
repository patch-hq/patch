// The Archived and Hidden sections' rows (spec/15 ## Chats tab §§5, 7). The
// cold-start roster excludes archived and hidden chats — archived are
// unbounded, and hidden ones live only in their own section — so each section
// fetches its own list (`GET /api/chats?archived=only`, `?hidden=only`) the
// moment it is needed: when the section opens, or when a search starts (search
// covers every section). The rows are merged into the chat store so they behave
// like any other row (swipe tray, long-press sheet, unarchive, Show), and are
// kept live from there by `chat.state`.
//
// A roster `hydrate` replaces the whole store and drops the merged rows, so the
// fetch re-runs on every `rosterGeneration` bump while the list is wanted.
//
// NO FALLBACK: a failed fetch raises a toast; the section shows what the store
// already holds and says nothing it does not know.

import React from 'react';
import { api, type ChatListEntry } from '../api/rest';
import { useChatStore } from '../stores/chatStore';
import { useUiStore } from '../stores/uiStore';
import { toChatListRow } from './chatListRow';

function useLazySection(
  wanted: boolean,
  fetch: () => Promise<{ chats: ChatListEntry[] }>,
  what: string,
): void {
  const generation = useChatStore((s) => s.rosterGeneration);
  React.useEffect(() => {
    if (!wanted) return;
    let live = true;
    fetch()
      .then((r) => {
        if (live) useChatStore.getState().mergeRows(r.chats.map(toChatListRow));
      })
      .catch((e: Error) => {
        useUiStore.getState().pushError(`failed to load ${what} chats: ${e.message}`);
      });
    return () => {
      live = false;
    };
  }, [wanted, generation]);
}

export const ARCHIVED_PAGE_SIZE = 30;

// Archived is unbounded, so it is paged like the web sidebar (spec/14 § Sidebar
// item 6): one page when the section opens, the next when the list is scrolled
// near its end (`loadMore`). `all` — a search is running — pulls every
// remaining page, because a local match further down would otherwise not show.
// A roster bump resets to the first page, as the rows were dropped.
type PagePosition = { cursor: string } | { offset: number };

/**
 * Where the next page starts, from a page's answer, or `null` when nothing is
 * left. A server released before the cursor sends only `nextOffset`; one that
 * sends neither is an error, never "start again from the top".
 */
export function nextArchivedPage(r: {
  nextCursor?: string | null;
  nextOffset?: number | null;
}): PagePosition | null {
  if (typeof r.nextCursor === 'string') return { cursor: r.nextCursor };
  if (r.nextCursor === null) return null;
  if (typeof r.nextOffset === 'number') return { offset: r.nextOffset };
  if (r.nextOffset === null) return null;
  throw new Error('the server said nothing about a next page');
}

export function useArchivedChats(wanted: boolean, all = false): { loadMore: () => void } {
  const generation = useChatStore((s) => s.rosterGeneration);
  // undefined = first page not requested; null = nothing left; otherwise where the next page starts.
  const nextRef = React.useRef<PagePosition | null | undefined>(undefined);
  const loadingRef = React.useRef(false);
  const liveRef = React.useRef(false);
  const allRef = React.useRef(all);
  allRef.current = all;

  const load = React.useCallback((at: PagePosition | undefined) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    api
      .listArchivedChats({ limit: ARCHIVED_PAGE_SIZE, ...at })
      .then((r) => {
        loadingRef.current = false;
        if (!liveRef.current) return;
        useChatStore.getState().mergeRows(r.chats.map(toChatListRow));
        const next = nextArchivedPage(r);
        nextRef.current = next;
        if (allRef.current && next !== null) load(next);
      })
      .catch((e: Error) => {
        loadingRef.current = false;
        if (!liveRef.current) return;
        useUiStore.getState().pushError(`failed to load archived chats: ${e.message}`);
      });
  }, []);

  React.useEffect(() => {
    if (!wanted) return;
    liveRef.current = true;
    nextRef.current = undefined;
    loadingRef.current = false;
    load(undefined);
    return () => {
      liveRef.current = false;
    };
  }, [wanted, generation, load]);

  React.useEffect(() => {
    if (!wanted || !all) return;
    const next = nextRef.current;
    if (next === null || next === undefined) return;
    load(next);
  }, [wanted, all, load]);

  const loadMore = React.useCallback(() => {
    const next = nextRef.current;
    if (next === null || next === undefined) return;
    load(next);
  }, [load]);

  return { loadMore };
}

export function useHiddenChats(wanted: boolean): void {
  useLazySection(wanted, () => api.listHiddenChats(), 'hidden');
}
