// meetingStore — each chat's meeting as the host last reported it
// (`meeting.state`), plus which chat THIS surface is capturing audio for.
// The host owns the meeting; this store only mirrors it.

import { create } from 'zustand';
import type { MeetingState } from '@patch/wire';

export type MeetingPromptKey = 'now' | 'notes' | 'actions';

interface MeetingStoreState {
  byChat: Record<string, MeetingState | null>;
  /** The chat this surface is currently capturing audio for, if any. */
  capturingChatId: string | null;
  /** Which meeting prompt the in-call editor is open on, if any. */
  promptEditor: MeetingPromptKey | null;
  openPromptEditor(key: MeetingPromptKey | null): void;
  apply(chatId: string, meeting: MeetingState | null): void;
  setCapturing(chatId: string | null): void;
  reset(): void;
}

export const useMeetingStore = create<MeetingStoreState>((set) => ({
  byChat: {},
  capturingChatId: null,
  promptEditor: null,
  openPromptEditor: (promptEditor) => set({ promptEditor }),
  apply: (chatId, meeting) => set((s) => ({ byChat: { ...s.byChat, [chatId]: meeting } })),
  setCapturing: (capturingChatId) => set({ capturingChatId }),
  reset: () => set({ byChat: {}, capturingChatId: null, promptEditor: null }),
}));

/** A meeting that is still running (live or paused). */
export function isMeetingOpen(m: MeetingState | null | undefined): m is MeetingState {
  return m != null && m.status !== 'ended';
}
