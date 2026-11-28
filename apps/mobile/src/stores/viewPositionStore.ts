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
  /** Server stamp of when the position was reported. */
  updatedAt: number;
  /**
   * This phone's clock: when the position reached it, or for a connect
   * snapshot the moment the previous socket was lost (0 for the first
   * connection of the process). Compared with the phone's last input to decide
   * which surface acted last.
   */
  arrivedAt: number;
  /** The first position of the process and this surface's own: a restart restoring where it closed. */
  restore: boolean;
}

export type IncomingPosition = Omit<RemotePosition, 'arrivedAt' | 'restore'>;

interface ViewPositionState {
  remote: RemotePosition | null;
  /** Server stamp of the newest position applied, dropped or authored here. */
  handledAt: number;
  /** Message seq under the middle of the open chat's viewport; null at the latest. */
  scroll: { chatId: string; seq: number | null } | null;
  /** The launch snapshot has arrived (the first position event of the session). */
  received: boolean;
  applyUpdated(pos: IncomingPosition, ownSurfaceId: string | null, arrivedAt: number): void;
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
  // only echoes. A reconnect re-sends a position already held; it keeps the
  // time it first arrived, so a resend never looks newer than what the user
  // has done since.
  applyUpdated: (pos, ownSurfaceId, arrivedAt) =>
    set((s) => {
      const own = pos.surfaceId === ownSurfaceId;
      if (own && s.received) return { handledAt: Math.max(s.handledAt, pos.updatedAt) };
      const known = s.remote !== null && s.remote.updatedAt === pos.updatedAt;
      return {
        remote: {
          ...pos,
          arrivedAt: known ? Math.min(s.remote!.arrivedAt, arrivedAt) : arrivedAt,
          restore: own && !s.received,
        },
        received: true,
      };
    }),
  markHandled: (updatedAt) => set((s) => ({ handledAt: Math.max(s.handledAt, updatedAt) })),
  setScroll: (chatId, seq) => set({ scroll: { chatId, seq } }),
}));
