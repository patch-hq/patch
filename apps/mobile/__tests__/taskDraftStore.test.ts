import { describe, it, expect, beforeEach } from 'vitest';
import { useTaskDraftStore } from '../src/stores/taskDraftStore';
import { store } from '../src/lib/credential';

describe('taskDraftStore', () => {
  beforeEach(() => useTaskDraftStore.getState()._reset());

  it('persists queued and typed tasks per chat and drops empty drafts', () => {
    const s = useTaskDraftStore.getState();
    s.set('c1', { queued: ['x'], typed: 'half' });
    expect(JSON.parse(store().getString('patch.task-drafts.v1') as string)).toEqual({
      c1: { queued: ['x'], typed: 'half' },
    });
    s.set('c1', { queued: [], typed: ' ' });
    expect(useTaskDraftStore.getState().drafts).toEqual({});
  });
});
