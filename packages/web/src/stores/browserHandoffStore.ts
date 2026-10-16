// browserHandoffStore — each chat's agent-browser live view and hand-off, as
// the host last reported them (`patch.browser_view.frame`,
// `patch.browser_handoff.state`). The host owns both; this only mirrors them.

import { create } from 'zustand';
import type {
  PatchBrowserHandoffStateEvent,
  PatchBrowserViewFrameEvent,
  PatchBrowserViewStatusEvent,
} from '@patch/wire';

export type BrowserFrame = Pick<
  PatchBrowserViewFrameEvent,
  'tabId' | 'data' | 'width' | 'height' | 'url' | 'title'
>;
export type BrowserHandoff = Pick<
  PatchBrowserHandoffStateEvent,
  'handoffId' | 'tabId' | 'reason' | 'startedAt'
>;

/** What the host last said this chat's browser is doing: running an action, and which tabs it has open. */
export type BrowserStatus = Pick<PatchBrowserViewStatusEvent, 'active' | 'action' | 'tabs'>;

interface BrowserHandoffStoreState {
  status: Record<string, BrowserStatus | undefined>;
  applyStatus(event: PatchBrowserViewStatusEvent): void;
  frames: Record<string, BrowserFrame | undefined>;
  /** A hand-off waiting on the user, per chat. */
  handoffs: Record<string, BrowserHandoff | undefined>;
  applyFrame(chatId: string, frame: BrowserFrame): void;
  applyState(event: PatchBrowserHandoffStateEvent): void;
  clearFrame(chatId: string): void;
  reset(): void;
}

export const useBrowserHandoffStore = create<BrowserHandoffStoreState>((set) => ({
  status: {},
  applyStatus: (e) =>
    set((s) => ({
      status: {
        ...s.status,
        [e.chatId]:
          e.tabs.length === 0 && !e.active
            ? undefined
            : { active: e.active, ...(e.action ? { action: e.action } : {}), tabs: e.tabs },
      },
    })),
  frames: {},
  handoffs: {},
  applyFrame: (chatId, frame) => set((s) => ({ frames: { ...s.frames, [chatId]: frame } })),
  applyState: (e) =>
    set((s) => ({
      handoffs: {
        ...s.handoffs,
        [e.chatId]:
          e.status === 'waiting'
            ? { handoffId: e.handoffId, tabId: e.tabId, reason: e.reason, startedAt: e.startedAt }
            : undefined,
      },
    })),
  clearFrame: (chatId) => set((s) => ({ frames: { ...s.frames, [chatId]: undefined } })),
  reset: () => set({ frames: {}, handoffs: {}, status: {} }),
}));
