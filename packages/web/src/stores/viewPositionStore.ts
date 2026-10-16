// The last position another surface reported, and this surface's own scroll
// position in the open chat (spec/05 § Handover). The sync component in
// AppShell decides when to apply `remote`; this store only holds the facts.

import { create } from 'zustand';

export interface RemotePosition {
  page: 'chat' | 'jobs' | 'job' | 'pads' | 'pad' | 'settings';
  id?: string;
  seq?: number;
  surfaceId: string;
  updatedAt: number;
}

interface ViewPositionState {
  remote: RemotePosition | null;
  /** Server stamp of the newest position applied here or authored here. */
  handledAt: number;
  /** Top-of-viewport message seq of the open chat; null when at the latest. */
  scroll: { chatId: string; seq: number | null } | null;
  applyUpdated(pos: RemotePosition, ownSurfaceId: string | null): void;
  markHandled(updatedAt: number): void;
  setScroll(chatId: string, seq: number | null): void;
}

export const useViewPositionStore = create<ViewPositionState>((set) => ({
  remote: null,
  handledAt: 0,
  scroll: null,
  applyUpdated: (pos, ownSurfaceId) =>
    set((s) =>
      pos.surfaceId === ownSurfaceId
        ? { handledAt: Math.max(s.handledAt, pos.updatedAt) }
        : { remote: pos },
    ),
  markHandled: (updatedAt) => set((s) => ({ handledAt: Math.max(s.handledAt, updatedAt) })),
  setScroll: (chatId, seq) => set({ scroll: { chatId, seq } }),
}));
