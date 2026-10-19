// Handover (spec/05 § Handover): URL <-> position mapping, and the sync
// component's rules — adopt on launch / foreground, report only after use.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { positionFromPath, pathFromPosition } from '../lib/viewPosition.js';
import { ViewPositionSync, VIEW_POSITION_DEBOUNCE_MS } from '../components/ViewPositionSync.js';
import { useViewPositionStore } from '../stores/viewPositionStore.js';
import { usePreferencesStore, DEFAULT_PREFERENCES } from '../stores/preferencesStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import type { PatchWs } from '../api/ws.js';

describe('position <-> path', () => {
  it('maps pages both ways', () => {
    expect(positionFromPath('/chats/c1', 12)).toEqual({ page: 'chat', id: 'c1', seq: 12 });
    expect(positionFromPath('/chats/c1', null)).toEqual({ page: 'chat', id: 'c1' });
    expect(positionFromPath('/chats/new', null)).toBeNull();
    expect(positionFromPath('/jobs', null)).toEqual({ page: 'jobs' });
    expect(positionFromPath('/jobs/j1', null)).toEqual({ page: 'job', id: 'j1' });
    expect(positionFromPath('/pads/p1', null)).toEqual({ page: 'pad', id: 'p1' });
    expect(positionFromPath('/settings/hosts', null)).toEqual({ page: 'settings' });
    expect(positionFromPath('/lifecycle/x', null)).toBeNull();
    expect(pathFromPosition({ page: 'chat', id: 'c1', seq: 12 })).toBe('/chats/c1?seq=12');
    expect(pathFromPosition({ page: 'chat', id: 'c1' })).toBe('/chats/c1');
    expect(pathFromPosition({ page: 'job', id: 'j1' })).toBe('/jobs/j1');
    expect(pathFromPosition({ page: 'settings' })).toBe('/settings');
  });
});

function Where(): null {
  const l = useLocation();
  (globalThis as { __where?: string }).__where = l.pathname + l.search;
  return null;
}
const where = (): string => (globalThis as { __where?: string }).__where ?? '';

function mount(initial: string): { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  render(
    <MemoryRouter initialEntries={[initial]}>
      <ViewPositionSync ws={{ send } as unknown as PatchWs} />
      <Where />
    </MemoryRouter>,
  );
  return { send };
}

const remote = (over: Record<string, unknown> = {}) => ({
  page: 'chat' as const,
  id: 'c9',
  seq: 5,
  surfaceId: 'phone',
  updatedAt: 100,
  ...over,
});

describe('ViewPositionSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useViewPositionStore.setState({ remote: null, handledAt: 0, scroll: null });
    usePresenceStore.setState({ surfaceId: 'desk' });
    usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES, loaded: true });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('adopts the other surface position when the launch snapshot arrives', () => {
    mount('/jobs');
    act(() => useViewPositionStore.getState().applyUpdated(remote(), 'desk'));
    expect(where()).toBe('/chats/c9?seq=5');
  });

  it("ignores its own surface's echo", () => {
    mount('/jobs');
    act(() => useViewPositionStore.getState().applyUpdated(remote({ surfaceId: 'desk' }), 'desk'));
    expect(where()).toBe('/jobs');
  });

  it('does not move a screen the user has already touched, until it returns to the foreground', () => {
    mount('/jobs');
    fireEvent.pointerDown(window);
    act(() => useViewPositionStore.getState().applyUpdated(remote(), 'desk'));
    expect(where()).toBe('/jobs');
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(where()).toBe('/chats/c9?seq=5');
  });

  it('adopts a position only once', () => {
    mount('/jobs');
    act(() => useViewPositionStore.getState().applyUpdated(remote(), 'desk'));
    act(() => {
      window.history.pushState({}, '', '/');
    });
    expect(useViewPositionStore.getState().handledAt).toBe(100);
  });

  it('reports nothing until the user has used the surface, then reports the page', () => {
    const { send } = mount('/chats/c1');
    act(() => {
      vi.advanceTimersByTime(VIEW_POSITION_DEBOUNCE_MS + 1);
    });
    expect(send).not.toHaveBeenCalled();

    fireEvent.pointerDown(window);
    act(() => useViewPositionStore.getState().setScroll('c1', 33));
    act(() => {
      vi.advanceTimersByTime(VIEW_POSITION_DEBOUNCE_MS + 1);
    });
    expect(send).toHaveBeenCalledWith({
      type: 'view_position.set',
      page: 'chat',
      id: 'c1',
      seq: 33,
    });
  });

  it('reports the open chat on first touch even when nothing else changes', () => {
    const { send } = mount('/chats/c1');
    act(() => {
      vi.advanceTimersByTime(VIEW_POSITION_DEBOUNCE_MS + 1);
    });
    expect(send).not.toHaveBeenCalled();
    fireEvent.pointerDown(window);
    act(() => {
      vi.advanceTimersByTime(VIEW_POSITION_DEBOUNCE_MS + 1);
    });
    expect(send).toHaveBeenCalledWith({ type: 'view_position.set', page: 'chat', id: 'c1' });
  });

  it('reports a chat at the latest message with no seq', () => {
    const { send } = mount('/chats/c1');
    fireEvent.keyDown(window);
    act(() => useViewPositionStore.getState().setScroll('c1', null));
    act(() => {
      vi.advanceTimersByTime(VIEW_POSITION_DEBOUNCE_MS + 1);
    });
    expect(send).toHaveBeenLastCalledWith({ type: 'view_position.set', page: 'chat', id: 'c1' });
  });

  it('neither adopts nor reports while "Sync position" is off', () => {
    usePreferencesStore.setState({
      preferences: { ...DEFAULT_PREFERENCES, syncPosition: false },
      loaded: true,
    });
    const { send } = mount('/jobs');
    act(() => useViewPositionStore.getState().applyUpdated(remote(), 'desk'));
    expect(where()).toBe('/jobs');
    fireEvent.pointerDown(window);
    act(() => useViewPositionStore.getState().setScroll('c1', 3));
    act(() => {
      vi.advanceTimersByTime(VIEW_POSITION_DEBOUNCE_MS + 1);
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('waits for the preferences to load before adopting the launch snapshot', () => {
    usePreferencesStore.setState({ loaded: false });
    mount('/jobs');
    act(() => useViewPositionStore.getState().applyUpdated(remote(), 'desk'));
    expect(where()).toBe('/jobs');
    act(() => usePreferencesStore.setState({ loaded: true }));
    expect(where()).toBe('/chats/c9?seq=5');
  });
});
