// Editor overhaul — climb out of the repo (spec/14 § File browser): the
// host-wide browser's position/recent-files state.

import { describe, it, expect, beforeEach } from 'vitest';
import { EMPTY_HOST_BROWSE_STATE, useUiStore } from '../stores/uiStore.js';

describe('uiStore — host browse', () => {
  beforeEach(() => {
    localStorage.clear();
    useUiStore.setState({
      hostBrowse: EMPTY_HOST_BROWSE_STATE,
      recentHostFiles: [],
    });
  });

  it('setHostBrowse merges and persists the position', () => {
    useUiStore.getState().setHostBrowse({ hostId: 'd1', path: '/home/tom' });
    expect(useUiStore.getState().hostBrowse).toMatchObject({ hostId: 'd1', path: '/home/tom' });
    useUiStore.getState().setHostBrowse({ openFile: { name: 'a.ts', path: 'a.ts' } });
    // The earlier fields survive a merge that only touches openFile.
    expect(useUiStore.getState().hostBrowse).toMatchObject({
      hostId: 'd1',
      path: '/home/tom',
      openFile: { name: 'a.ts', path: 'a.ts' },
    });
    const raw = JSON.parse(localStorage.getItem('patch.browse.host.v1')!);
    expect(raw).toEqual({
      hostId: 'd1',
      path: '/home/tom',
      openFile: { name: 'a.ts', path: 'a.ts' },
    });
  });

  it('addRecentHostFile is newest-first, deduped by (hostId, path), capped', () => {
    const s = useUiStore.getState();
    s.addRecentHostFile({ hostId: 'd1', path: '/a.ts', name: 'a.ts' });
    s.addRecentHostFile({ hostId: 'd1', path: '/b.ts', name: 'b.ts' });
    // Re-opening a.ts moves it back to the front instead of duplicating it.
    s.addRecentHostFile({ hostId: 'd1', path: '/a.ts', name: 'a.ts' });
    const names = useUiStore.getState().recentHostFiles.map((f) => f.path);
    expect(names).toEqual(['/a.ts', '/b.ts']);

    for (let i = 0; i < 25; i++) {
      useUiStore
        .getState()
        .addRecentHostFile({ hostId: 'd1', path: `/f${i}.ts`, name: `f${i}.ts` });
    }
    expect(useUiStore.getState().recentHostFiles.length).toBeLessThanOrEqual(20);
  });
});
