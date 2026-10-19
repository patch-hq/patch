// hostSearchStore — ⌘⇧F search in files (spec/14 § File browser — search
// in files; spec/03 § Host search).
//
// One search at a time, by design: opening a new one (or re-running the
// current one) replaces whatever was running, mirroring how the picker itself
// is a single modal. `ingest` is wired from `ws.ts`'s dispatch, routed by the
// hub to this surface alone (`forSurfaceId`), so every result/done frame that
// arrives here really is for the search this store thinks is running.

import { create } from 'zustand';
import type { WireEvent } from '@patch/wire';

export type HostSearchMatch = Extract<
  WireEvent,
  { type: 'patch.host_search.result' }
>['matches'][number];

export type HostSearchStatus = 'running' | 'done' | 'cancelled' | 'error';

interface HostSearchState {
  searchId: string | null;
  hostId: string | null;
  root: string;
  query: string;
  status: HostSearchStatus | null;
  matches: HostSearchMatch[];
  truncated: boolean;
  error: string | null;
  /** Record a search this surface just sent `patch.host_search.request` for. */
  start(searchId: string, hostId: string, root: string, query: string): void;
  /** A frame addressed to this surface — ignored if it names a stale searchId. */
  ingest(event: WireEvent): void;
  /** Mark the CURRENT search cancelled locally (the cancel frame itself is fire-and-forget). */
  cancel(): void;
  reset(): void;
}

export const useHostSearchStore = create<HostSearchState>((set, get) => ({
  searchId: null,
  hostId: null,
  root: '',
  query: '',
  status: null,
  matches: [],
  truncated: false,
  error: null,
  start(searchId, hostId, root, query) {
    set({
      searchId,
      hostId,
      root,
      query,
      status: 'running',
      matches: [],
      truncated: false,
      error: null,
    });
  },
  ingest(event) {
    const { searchId } = get();
    if (searchId === null) return;
    if (event.type === 'patch.host_search.result' && event.searchId === searchId) {
      set({ matches: [...get().matches, ...event.matches] });
      return;
    }
    if (event.type === 'patch.host_search.done' && event.searchId === searchId) {
      set({
        status: event.ok ? 'done' : 'error',
        truncated: event.truncated === true,
        error: event.ok ? null : (event.error?.message ?? 'search failed'),
      });
    }
  },
  cancel() {
    if (get().status === 'running') set({ status: 'cancelled' });
  },
  reset() {
    set({
      searchId: null,
      hostId: null,
      root: '',
      query: '',
      status: null,
      matches: [],
      truncated: false,
      error: null,
    });
  },
}));

/** A fresh per-search id, same shape convention as `terminalStore`'s session ids. */
export function newHostSearchId(): string {
  return `search-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
