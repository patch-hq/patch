// Job drafts — a job form's unsaved edits, kept when the user moves off the job
// tab (spec/14 § Jobs view — Unsaved changes).
//
// They used to live only in JobEditorRoute's component state, so leaving the
// tab (or a reload) dropped them, and the only protection was a discard prompt.
// LOCAL ONLY, keyed by job id (`new` for the unsaved new-job form): it is one
// surface's unsent work, like a half-typed task.
//
// NO FALLBACK: corrupt or absent storage yields no draft; a failed save is
// surfaced as an error toast rather than swallowed.

import { create } from 'zustand';
import { useUiStore } from './uiStore.js';

const STORAGE_KEY = 'patch.job-drafts.v1';

const SAVE_FAILED_MESSAGE = 'Couldn’t save your job draft — it will be lost if you reload.';

/** A form snapshot: primitives and primitive arrays only, as `isDirty` requires. */
export type JobDraftForm = Record<string, string | number | boolean | null | string[]>;

function loadCache(): Record<string, JobDraftForm> {
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
    const out: Record<string, JobDraftForm> = {};
    for (const [jobId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      out[jobId] = value as JobDraftForm;
    }
    return out;
  } catch {
    return {};
  }
}

function persist(drafts: Record<string, JobDraftForm>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch (err) {
    useUiStore.getState().pushError(SAVE_FAILED_MESSAGE, undefined, (err as Error).message);
  }
}

interface JobDraftStore {
  drafts: Record<string, JobDraftForm>;
  set(jobId: string, form: JobDraftForm): void;
  clear(jobId: string): void;
  /** Test seam — the store loads once at module init and outlives a render. */
  _reset(): void;
}

export const useJobDraftStore = create<JobDraftStore>((set, get) => ({
  drafts: loadCache(),

  set(jobId, form) {
    const drafts = { ...get().drafts, [jobId]: form };
    persist(drafts);
    set({ drafts });
  },

  clear(jobId) {
    if (!(jobId in get().drafts)) return;
    const drafts = { ...get().drafts };
    delete drafts[jobId];
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
