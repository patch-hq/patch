// The last position another surface reported, and this surface's own scroll
// position in the open chat (spec/05 § Handover). The sync component decides
// when to apply `remote`; this store only holds the facts.

import { create } from 'zustand';
import type { ViewPage } from '@patch/wire';

export interface RemotePosition {
  page: ViewPage;
  id?: string;
  seq?: number;
  surfaceId: string;
  updatedAt: number;
}

interface ViewPositionState {
  remote: RemotePosition | null;
  /** Server stamp of the newest position applied here or authored here. */
  handledAt: number;
  /** Message seq under the middle of the open chat's viewport; null at the latest. */
  scroll: { chatId: string; seq: number | null } | null;
  /** The launch snapshot has arrived (the first position event of the session). */
  received: boolean;
  applyUpdated(pos: RemotePosition, ownSurfaceId: string | null): void;
  markHandled(updatedAt: number): void;
  setScroll(chatId: string, seq: number | null): void;
}

export const useViewPositionStore = create<ViewPositionState>((set) => ({
  remote: null,
  handledAt: 0,
  scroll: null,
  received: false,
  // The first event is the launch snapshot and is kept even when this surface
  // wrote it: a restart is the same surface, and is how it finds its way back
  // to the chat and position it closed on. Later events from this surface are
  // only echoes.
  applyUpdated: (pos, ownSurfaceId) =>
    set((s) =>
      pos.surfaceId === ownSurfaceId && s.received
        ? { handledAt: Math.max(s.handledAt, pos.updatedAt) }
        : { remote: pos, received: true },
    ),
  markHandled: (updatedAt) => set((s) => ({ handledAt: Math.max(s.handledAt, updatedAt) })),
  setScroll: (chatId, seq) => set({ scroll: { chatId, seq } }),
}));
