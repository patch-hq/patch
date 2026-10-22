// Jobs page instant open: the last answer paints with no "Loading…" and is then
// replaced by the live fetch (spec/14 § Jobs view).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JobsRoute } from '../routes/JobsRoute.js';
import { JOBS_CACHE_KEY, loadCachedJobs } from '../lib/jobsCache.js';
import { clearCredential } from '../lib/credential.js';

function job(id: string, name: string) {
  return {
    id,
    name,
    enabled: true,
    trigger: { type: 'cron', expression: '57 8 * * 1-5' },
    filter: null,
    action: { type: 'spawn', hostId: 'd1', folder: '~/p', skill: 's' },
    createdAt: 1,
    updatedAt: 1,
    latestRun: null,
  };
}

function renderJobs() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <JobsRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('JobsRoute read cache', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('paints cached jobs immediately, never showing Loading…, then swaps in the live list', async () => {
    window.localStorage.setItem(JOBS_CACHE_KEY, JSON.stringify({ jobs: [job('a', 'cached-job')] }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await gate;
        return new Response(JSON.stringify({ jobs: [job('b', 'live-job')] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    renderJobs();
    expect(screen.getByText('cached-job')).toBeTruthy();
    expect(screen.queryByText('Loading…')).toBeNull();
    release();
    await waitFor(() => expect(screen.getByText('live-job')).toBeTruthy());
    expect(screen.queryByText('cached-job')).toBeNull();
    expect(loadCachedJobs<{ id: string }>()?.jobs[0]?.id).toBe('b');
  });

  it('reports and drops an unreadable cache', () => {
    window.localStorage.setItem(JOBS_CACHE_KEY, '{nope');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(loadCachedJobs()).toBeUndefined();
    expect(err).toHaveBeenCalled();
    expect(window.localStorage.getItem(JOBS_CACHE_KEY)).toBeNull();
  });

  it('is cleared on sign-out', () => {
    window.localStorage.setItem(JOBS_CACHE_KEY, JSON.stringify({ jobs: [] }));
    clearCredential();
    expect(window.localStorage.getItem(JOBS_CACHE_KEY)).toBeNull();
  });
});
