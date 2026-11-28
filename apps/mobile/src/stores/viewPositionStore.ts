// The last position another surface reported, the handover offer on screen,
// and this surface's own scroll position in the open chat (spec/05 §
// Handover). ViewPositionSync decides; this store only holds the facts.

import { create } from 'zustand';
import type { ViewPage } from '@patch/wire';

export interface RemotePosition {
  page: ViewPage;
  id?: string;
  seq?: number;
  surfaceId: string;
  surfaceKind?: string;
  /** Server stamp of when the position was reported. */
  updatedAt: number;
  /** It came as the snapshot sent when the socket connected, not as a live move. */
  snapshot: boolean;
}

export type IncomingPosition = Omit<RemotePosition, 'snapshot'>;

interface ViewPositionState {
  remote: RemotePosition | null;
  /** A missed move offered as "Continue from …"; null when none is on screen. */
  offer: RemotePosition | null;
  /** Message seq under the middle of the open chat's viewport; null at the latest. */
  scroll: { chatId: string; seq: number | null } | null;
  applyUpdated(pos: IncomingPosition, snapshot: boolean): void;
  setOffer(offer: RemotePosition | null): void;
  setScroll(chatId: string, seq: number | null): void;
}

export const useViewPositionStore = create<ViewPositionState>((set) => ({
  remote: null,
  offer: null,
  scroll: null,
  applyUpdated: (pos, snapshot) => set({ remote: { ...pos, snapshot } }),
  setOffer: (offer) => set({ offer }),
  // The same place again is not a change: a fresh object would re-run the
  // report and look like a move (spec/05 § Handover — Reporting).
  setScroll: (chatId, seq) =>
    set((s) =>
      s.scroll?.chatId === chatId && s.scroll.seq === seq ? s : { scroll: { chatId, seq } },
    ),
}));
