// The jobs-list read cache (spec/15 § Instant open (read cache)). MMKV mirror
// of the last `GET /api/jobs` answer, so the Jobs list paints on first render
// instead of "Loading…". JobList's fetch replaces it wholesale on every focus.

import { store, JOBS_LIST_KEY } from './credential';
import { useUiStore } from '../stores/uiStore';

/** Cached raw job rows, or undefined when nothing usable is on disk. Never throws; bad content is reported and dropped. */
export function loadCachedJobs(): unknown[] | undefined {
  const raw = store().getString(JOBS_LIST_KEY);
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('cached jobs list is not an array');
    return parsed;
  } catch (e) {
    store().delete(JOBS_LIST_KEY);
    useUiStore.getState().pushError(`jobs cache unreadable: ${(e as Error).message}`);
    return undefined;
  }
}

export function saveCachedJobs(jobs: unknown[]): void {
  store().set(JOBS_LIST_KEY, JSON.stringify(jobs));
}
