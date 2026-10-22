// The jobs-list read cache (spec/14 § Jobs view — instant open). A mirror of
// the last `GET /api/jobs` answer, painted as the query's initial data so the
// Jobs page never shows "Loading…" after the first visit. The query still
// refetches on mount and replaces it wholesale; the cache is never a source of
// truth. Unreadable content is reported and dropped, not silently ignored.

export const JOBS_CACHE_KEY = 'patch.jobsList.v1';

export function loadCachedJobs<T>(): { jobs: T[] } | undefined {
  const raw = window.localStorage.getItem(JOBS_CACHE_KEY);
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    const jobs = (parsed as { jobs?: unknown } | null)?.jobs;
    if (!Array.isArray(jobs)) throw new Error('cached jobs list has no jobs array');
    return { jobs: jobs as T[] };
  } catch (e) {
    window.localStorage.removeItem(JOBS_CACHE_KEY);
    console.error(`jobs cache unreadable: ${(e as Error).message}`);
    return undefined;
  }
}

export function saveCachedJobs(data: { jobs: unknown[] }): void {
  window.localStorage.setItem(JOBS_CACHE_KEY, JSON.stringify({ jobs: data.jobs }));
}
