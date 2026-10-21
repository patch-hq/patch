// meetingStore — each chat's meeting as the host last reported it
// (`meeting.state`), plus which chat THIS surface is capturing audio for.
// The host owns the meeting; this store only mirrors it.

import { create } from 'zustand';
import type { MeetingState } from '@patch/wire';

export type MeetingPromptKey = 'now' | 'notes' | 'actions';

/** What the meeting shows in place of the chat: the notes as they build up, or the transcript. */
export type MeetingView = 'summary' | 'transcript';

const FOLDED_KEY = 'patch.meetingFolded';

/** Chats whose ended meeting Tom folded away, remembered across reloads. */
function readFolded(): Record<string, true> {
  try {
    const v = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, true>) : {};
  } catch {
    // A corrupt key is only a UI preference: start unfolded, and say so.
    console.warn('meetingStore: unreadable folded meetings, starting unfolded');
    return {};
  }
}

interface MeetingStoreState {
  byChat: Record<string, MeetingState | null>;
  /** The chat this surface is currently capturing audio for, if any. */
  capturingChatId: string | null;
  /** Which meeting prompt the in-call editor is open on, if any. */
  promptEditor: MeetingPromptKey | null;
  /** Whether the right panel shows the meeting's settings (the cog) instead of its tab. */
  settingsOpen: boolean;
  setSettingsOpen(open: boolean): void;
  /** Per chat: Summary or Transcript. Absent is Summary. */
  view: Record<string, MeetingView>;
  setView(chatId: string, view: MeetingView): void;
  /** Per chat: the ended meeting is folded into one line and the chat has the room. */
  folded: Record<string, true>;
  setFolded(chatId: string, folded: boolean): void;
  /** Per chat: the composer asks the agent (true) or writes a note into the meeting. Absent: Note while it runs, Ask once it has ended. */
  asking: Record<string, boolean>;
  setAsking(chatId: string, asking: boolean): void;
  /** Opens the settings on one prompt; null closes the prompt editor and leaves the settings open. */
  openPromptEditor(key: MeetingPromptKey | null): void;
  apply(chatId: string, meeting: MeetingState | null): void;
  setCapturing(chatId: string | null): void;
  reset(): void;
}

export const useMeetingStore = create<MeetingStoreState>((set) => ({
  byChat: {},
  capturingChatId: null,
  promptEditor: null,
  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  view: {},
  setView: (chatId, view) => set((s) => ({ view: { ...s.view, [chatId]: view } })),
  folded: readFolded(),
  setFolded: (chatId, folded) =>
    set((s) => {
      const next = { ...s.folded };
      if (folded) next[chatId] = true;
      else delete next[chatId];
      localStorage.setItem(FOLDED_KEY, JSON.stringify(next));
      return { folded: next };
    }),
  asking: {},
  setAsking: (chatId, asking) => set((s) => ({ asking: { ...s.asking, [chatId]: asking } })),
  openPromptEditor: (promptEditor) =>
    set(promptEditor ? { promptEditor, settingsOpen: true } : { promptEditor }),
  apply: (chatId, meeting) => set((s) => ({ byChat: { ...s.byChat, [chatId]: meeting } })),
  setCapturing: (capturingChatId) => set({ capturingChatId }),
  reset: () =>
    set({
      byChat: {},
      capturingChatId: null,
      promptEditor: null,
      settingsOpen: false,
      view: {},
      asking: {},
    }),
}));

/** A meeting that is still running (live or paused). */
export function isMeetingOpen(m: MeetingState | null | undefined): m is MeetingState {
  return m != null && m.status !== 'ended';
}

/** The meeting takes over the chat: there is one, and it has not been folded away after it ended. */
export function isMeetingShown(
  m: MeetingState | null | undefined,
  folded: boolean,
): m is MeetingState {
  return m != null && (m.status !== 'ended' || !folded);
}

/** Whether the composer asks the agent rather than writing a note, for a shown meeting. */
export function useMeetingAsking(chatId: string): boolean {
  return useMeetingStore((s) => s.asking[chatId] ?? s.byChat[chatId]?.status === 'ended');
}
