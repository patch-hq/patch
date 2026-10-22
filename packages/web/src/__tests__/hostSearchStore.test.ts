// hostSearchStore — ⌘⇧F search in files (spec/14 § File browser, spec/03 §
// Host search): a frame is only ever applied against the search the store
// thinks is CURRENTLY running — a stale searchId's frames are ignored.

import { describe, it, expect, beforeEach } from 'vitest';
import { newHostSearchId, useHostSearchStore } from '../stores/hostSearchStore.js';

beforeEach(() => {
  useHostSearchStore.getState().reset();
});

describe('hostSearchStore', () => {
  it('start resets to a fresh running search', () => {
    useHostSearchStore.getState().start('s1', 'd1', '/proj', 'needle');
    expect(useHostSearchStore.getState()).toMatchObject({
      searchId: 's1',
      hostId: 'd1',
      root: '/proj',
      query: 'needle',
      status: 'running',
      matches: [],
      truncated: false,
      error: null,
    });
  });

  it('ingest accumulates results across multiple batches', () => {
    useHostSearchStore.getState().start('s1', 'd1', '/proj', 'needle');
    useHostSearchStore.getState().ingest({
      type: 'patch.host_search.result',
      searchId: 's1',
      matches: [{ path: 'a.ts', line: 1, column: 1, preview: 'needle here' }],
    });
    useHostSearchStore.getState().ingest({
      type: 'patch.host_search.result',
      searchId: 's1',
      matches: [{ path: 'b.ts', line: 3, column: 2, preview: 'needle there' }],
    });
    expect(useHostSearchStore.getState().matches).toHaveLength(2);
  });

  it('ignores a result/done frame for a searchId that is not the current one', () => {
    useHostSearchStore.getState().start('s2', 'd1', '/proj', 'needle');
    useHostSearchStore.getState().ingest({
      type: 'patch.host_search.result',
      searchId: 's1', // stale — a previous search's late frame
      matches: [{ path: 'a.ts', line: 1, column: 1, preview: 'x' }],
    });
    expect(useHostSearchStore.getState().matches).toHaveLength(0);
  });

  it('done marks status/truncated/error from the frame', () => {
    useHostSearchStore.getState().start('s1', 'd1', '/proj', 'needle');
    useHostSearchStore.getState().ingest({
      type: 'patch.host_search.done',
      searchId: 's1',
      ok: true,
      truncated: true,
    });
    expect(useHostSearchStore.getState()).toMatchObject({
      status: 'done',
      truncated: true,
      error: null,
    });
  });

  it('a failed done carries the error message', () => {
    useHostSearchStore.getState().start('s1', 'd1', '/proj', 'needle');
    useHostSearchStore.getState().ingest({
      type: 'patch.host_search.done',
      searchId: 's1',
      ok: false,
      error: { code: 'not_found', message: 'nothing at /proj' },
    });
    expect(useHostSearchStore.getState()).toMatchObject({
      status: 'error',
      error: 'nothing at /proj',
    });
  });

  it('cancel marks a running search cancelled, but not a finished one', () => {
    useHostSearchStore.getState().start('s1', 'd1', '/proj', 'needle');
    useHostSearchStore.getState().cancel();
    expect(useHostSearchStore.getState().status).toBe('cancelled');

    useHostSearchStore.getState().start('s2', 'd1', '/proj', 'needle');
    useHostSearchStore
      .getState()
      .ingest({ type: 'patch.host_search.done', searchId: 's2', ok: true });
    useHostSearchStore.getState().cancel();
    expect(useHostSearchStore.getState().status).toBe('done');
  });

  it('newHostSearchId mints a unique id each call', () => {
    expect(newHostSearchId()).not.toBe(newHostSearchId());
  });
});
