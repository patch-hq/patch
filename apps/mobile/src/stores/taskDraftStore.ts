// Task drafts — tasks typed into a chat's task bar but not yet handed to the
// agent with Done (spec/15 § Task list). Surface-local and persisted (MMKV) so
// an app restart does not silently drop them.
//
// NO FALLBACK: corrupt or absent storage yields no drafts, never guessed ones.

import { create } from 'zustand';
import { store } from '../lib/credential';

const KEY = 'patch.task-drafts.v1';

export interface TaskDraft {
  queued: string[];
  typed: string;
}

function isEmpty(d: TaskDraft): boolean {
  return d.queued.length === 0 && d.typed.trim() === '';
}

function load(): Record<string, TaskDraft> {
  const raw = store().getString(KEY);
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

interface TaskDraftStore {
  drafts: Record<string, TaskDraft>;
  set(chatId: string, draft: TaskDraft): void;
  _reset(): void;
}

export const useTaskDraftStore = create<TaskDraftStore>((set, get) => ({
  drafts: load(),

  set(chatId, draft) {
    const drafts = { ...get().drafts };
    if (isEmpty(draft)) delete drafts[chatId];
    else drafts[chatId] = draft;
    store().set(KEY, JSON.stringify(drafts));
    set({ drafts });
  },

  _reset() {
    store().delete(KEY);
    set({ drafts: {} });
  },
}));
