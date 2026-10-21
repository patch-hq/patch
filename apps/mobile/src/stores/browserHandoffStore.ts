// browserHandoffStore — each chat's agent-browser live view and hand-off, as
// the host last reported them (`patch.browser_view.frame`,
// `patch.browser_view.status`, `patch.browser_handoff.state`,
// `patch.browser_view.form`), plus how this phone is showing it: only the bar,
// the live card above the composer, or open over the whole screen.
// Mirrors packages/web/src/stores/browserHandoffStore.ts.

import { create } from 'zustand';
import type {
  PatchBrowserHandoffStateEvent,
  PatchBrowserViewFormEvent,
  PatchBrowserViewFrameEvent,
  PatchBrowserViewStatusEvent,
} from '@patch/wire';

export type BrowserFrame = Pick<
  PatchBrowserViewFrameEvent,
  | 'tabId'
  | 'data'
  | 'width'
  | 'height'
  | 'url'
  | 'title'
  | 'inputVersion'
  | 'canGoBack'
  | 'canGoForward'
>;
export type BrowserHandoff = Pick<
  PatchBrowserHandoffStateEvent,
  'handoffId' | 'tabId' | 'reason' | 'startedAt'
>;

/** What the host last said this chat's browser is doing: running an action, and which tabs it has open. */
export type BrowserStatus = Pick<
  PatchBrowserViewStatusEvent,
  'active' | 'action' | 'tabs' | 'since'
>;

export type BrowserForm = Pick<PatchBrowserViewFormEvent, 'tabId' | 'formId' | 'site' | 'fields'>;

/** `card`: live above the composer. `open`: over the whole screen. Absent: only the bar. */
export type BrowserViewMode = 'card' | 'open';

interface BrowserHandoffStoreState {
  status: Record<string, BrowserStatus | undefined>;
  applyStatus(event: PatchBrowserViewStatusEvent): void;
  frames: Record<string, BrowserFrame | undefined>;
  /** A hand-off waiting on the user, per chat. */
  handoffs: Record<string, BrowserHandoff | undefined>;
  forms: Record<string, BrowserForm | undefined>;
  views: Record<string, BrowserViewMode | undefined>;
  applyFrame(chatId: string, frame: BrowserFrame): void;
  applyState(event: PatchBrowserHandoffStateEvent): void;
  applyForm(event: PatchBrowserViewFormEvent): void;
  setView(chatId: string, mode: BrowserViewMode | undefined): void;
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
            : {
                active: e.active,
                ...(e.action ? { action: e.action } : {}),
                tabs: e.tabs,
                ...(e.since !== undefined ? { since: e.since } : {}),
              },
      },
      ...(e.tabs.length === 0 && !e.active && !s.handoffs[e.chatId]
        ? { views: { ...s.views, [e.chatId]: undefined } }
        : {}),
    })),
  frames: {},
  handoffs: {},
  forms: {},
  views: {},
  applyFrame: (chatId, frame) => set((s) => ({ frames: { ...s.frames, [chatId]: frame } })),
  applyState: (e) =>
    set((s) => {
      const waiting = e.status === 'waiting';
      const isNew = waiting && s.handoffs[e.chatId]?.handoffId !== e.handoffId;
      return {
        handoffs: {
          ...s.handoffs,
          [e.chatId]: waiting
            ? { handoffId: e.handoffId, tabId: e.tabId, reason: e.reason, startedAt: e.startedAt }
            : undefined,
        },
        ...(waiting ? {} : { forms: { ...s.forms, [e.chatId]: undefined } }),
        // The agent asking for the user brings the card up by itself.
        ...(isNew && !s.views[e.chatId]
          ? { views: { ...s.views, [e.chatId]: 'card' as const } }
          : {}),
      };
    }),
  applyForm: (e) =>
    set((s) => ({
      forms: {
        ...s.forms,
        [e.chatId]:
          e.fields.length === 0
            ? undefined
            : { tabId: e.tabId, formId: e.formId, site: e.site, fields: e.fields },
      },
    })),
  setView: (chatId, mode) => set((s) => ({ views: { ...s.views, [chatId]: mode } })),
  clearFrame: (chatId) => set((s) => ({ frames: { ...s.frames, [chatId]: undefined } })),
  reset: () => set({ frames: {}, handoffs: {}, status: {}, forms: {}, views: {} }),
}));
