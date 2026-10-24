// Task drafts — the tasks a user has typed into a chat's task bar but not yet
// handed to the agent with Done (spec/14 § Task list, queueing).
//
// They used to live only in TaskBar's component state, so a window reload (or
// anything that remounted the bar) silently dropped them. LOCAL ONLY, keyed by
// chat: it is one surface's unsent work, like a half-made question selection.
//
// NO FALLBACK: corrupt or absent storage yields no draft; a failed save is
// surfaced as an error toast rather than swallowed.

import { create } from 'zustand';
import { useUiStore } from './uiStore.js';

const STORAGE_KEY = 'patch.task-drafts.v1';

const SAVE_FAILED_MESSAGE = 'Couldn’t save your queued tasks — they will be lost if you reload.';

export interface TaskDraft {
  /** Tasks queued with Enter, waiting for Done. */
  queued: string[];
  /** Text typed into the add row but not yet queued. */
  typed: string;
}

function isEmpty(d: TaskDraft): boolean {
  return d.queued.length === 0 && d.typed.trim() === '';
}

function loadCache(): Record<string, TaskDraft> {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, TaskDraft> = {};
    for (const [chatId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const d = value as Record<string, unknown>;
      if (!Array.isArray(d.queued) || !d.queued.every((q) => typeof q === 'string')) continue;
      if (typeof d.typed !== 'string') continue;
      const draft = { queued: d.queued as string[], typed: d.typed };
      if (!isEmpty(draft)) out[chatId] = draft;
    }
    return out;
  } catch {
    return {};
  }
}

function persist(drafts: Record<string, TaskDraft>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch (err) {
    useUiStore.getState().pushError(SAVE_FAILED_MESSAGE, undefined, (err as Error).message);
  }
}

interface TaskDraftStore {
  drafts: Record<string, TaskDraft>;
  set(chatId: string, draft: TaskDraft): void;
  /** Test seam — the store loads once at module init and outlives a render. */
  _reset(): void;
}

export const useTaskDraftStore = create<TaskDraftStore>((set, get) => ({
  drafts: loadCache(),

  set(chatId, draft) {
    const drafts = { ...get().drafts };
    if (isEmpty(draft)) delete drafts[chatId];
    else drafts[chatId] = draft;
    persist(drafts);
    set({ drafts });
  },

  _reset() {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing to clear if storage is unavailable.
    }
    set({ drafts: {} });
  },
}));
