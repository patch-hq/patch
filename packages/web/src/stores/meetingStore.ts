// meetingStore — each chat's meeting as the host last reported it
// (`meeting.state`), plus which chat THIS surface is capturing audio for.
// The host owns the meeting; this store only mirrors it.

import { create } from 'zustand';
import type { MeetingState } from '@patch/wire';

export type MeetingPromptKey = 'now' | 'notes' | 'actions';

/** What the meeting panel shows: the one feed of notes, research and actions, or the whole transcript. */
export type MeetingView = 'notes' | 'transcript';

const FOLDED_KEY = 'patch.meetingFolded';
const HEIGHT_KEY = 'patch.meetingPanelHeight';

/** The meeting panel's share of the chat's height, as Tom last dragged it. */
export const MEETING_HEIGHT_DEFAULT = 0.6;
export const MEETING_HEIGHT_MIN = 0.15;
export const MEETING_HEIGHT_MAX = 0.9;

function readHeight(): number {
  const raw = localStorage.getItem(HEIGHT_KEY);
  if (raw === null) return MEETING_HEIGHT_DEFAULT;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < MEETING_HEIGHT_MIN || v > MEETING_HEIGHT_MAX) {
    console.warn(`meetingStore: ignoring stored panel height ${raw}`);
    return MEETING_HEIGHT_DEFAULT;
  }
  return v;
}

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
  /** Per chat: which tab of the meeting panel is open. Absent is Notes. */
  view: Record<string, MeetingView>;
  setView(chatId: string, view: MeetingView): void;
  /** Per chat: the ended meeting is folded into one line and the chat has the room. */
  folded: Record<string, true>;
  setFolded(chatId: string, folded: boolean): void;
  /** The panel's share of the chat's height (the drag bar under it), remembered across reloads. */
  height: number;
  setHeight(height: number): void;
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
  height: readHeight(),
  setHeight: (h) => {
    const height = Math.min(MEETING_HEIGHT_MAX, Math.max(MEETING_HEIGHT_MIN, h));
    localStorage.setItem(HEIGHT_KEY, String(height));
    set({ height });
  },
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
    }),
}));

/** A meeting that is still running (live or paused). */
export function isMeetingOpen(m: MeetingState | null | undefined): m is MeetingState {
  return m != null && m.status !== 'ended';
}

/** The meeting's panel is shown: there is one, and it has not been folded away after it ended. */
export function isMeetingShown(
  m: MeetingState | null | undefined,
  folded: boolean,
): m is MeetingState {
  return m != null && (m.status !== 'ended' || !folded);
}
