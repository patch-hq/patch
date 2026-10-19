// Handover (spec/05 § Handover): route <-> position mapping, and the sync
// component's rules — adopt on launch / foreground, report only after use.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderRN, actSync } from './testUtils/render';
import {
  routerMock,
  __resetRouterMock,
  __setCurrentRoute,
  __setRootNavigationReady,
  __emitNavigationEvent,
  __navigationListenerCount,
} from './stubs/expo-router';
import { __emitAppStateChange } from './stubs/react-native';
import { positionFromRoute, routeFromPosition, pathFromRoute } from '../src/lib/viewPosition';
import { useViewPositionStore } from '../src/stores/viewPositionStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { getWs } from '../src/api/ws';
import { useSettingsStore } from '../src/stores/settingsStore';
import { seedSettings, settingsFixture } from './testUtils/settingsFixtures';

vi.mock('../src/api/ws', () => ({ getWs: vi.fn() }));

import {
  ViewPositionSync,
  VIEW_POSITION_DEBOUNCE_MS,
  EXPLICIT_NAV_HOLD_MS,
  noteExplicitNavigation,
  noteUserInput,
  resetViewPositionSync,
} from '../src/components/ViewPositionSync';

describe('position <-> route', () => {
  it('maps screens both ways', () => {
    expect(positionFromRoute('/chats/c1', {}, 12)).toEqual({ page: 'chat', id: 'c1', seq: 12 });
    expect(positionFromRoute('/chats/c1', {}, null)).toEqual({ page: 'chat', id: 'c1' });
    expect(positionFromRoute('/(tabs)/jobs', {}, null)).toEqual({ page: 'jobs' });
    expect(positionFromRoute('/settings/job-editor', { id: 'j1' }, null)).toEqual({
      page: 'job',
      id: 'j1',
    });
    expect(positionFromRoute('/pads/p1', {}, null)).toEqual({ page: 'pad', id: 'p1' });
    expect(positionFromRoute('/pair', {}, null)).toBeNull();
    expect(routeFromPosition({ page: 'chat', id: 'c1', seq: 12 })).toBe('/chats/c1?seq=12');
    expect(routeFromPosition({ page: 'job', id: 'j1' })).toBe('/settings/job-editor?id=j1');
    expect(routeFromPosition({ page: 'jobs' })).toBe('/jobs');
  });
});

describe('pathFromRoute', () => {
  it('rebuilds the path from a file-based route name and its params', () => {
    expect(pathFromRoute('chats/[chatId]', { chatId: 'c1' })).toBe('/chats/c1');
    expect(pathFromRoute('chats/[chatId]', { chatId: 'a b/c' })).toBe('/chats/a%20b%2Fc');
    expect(pathFromRoute('jobs', undefined)).toBe('/jobs');
    expect(pathFromRoute('pads/index', undefined)).toBe('/pads');
    expect(pathFromRoute('index', undefined)).toBe('/');
    expect(pathFromRoute('docs/[...rest]', { rest: ['a', 'b'] })).toBe('/docs/a/b');
    // The encoded second segment round-trips through the position mapping.
    expect(
      positionFromRoute(pathFromRoute('chats/[chatId]', { chatId: 'a b/c' }), {}, null),
    ).toEqual({
      page: 'chat',
      id: 'a b/c',
    });
  });

  it('throws on a dynamic segment with no param rather than inventing a path', () => {
    expect(() => pathFromRoute('chats/[chatId]', {})).toThrow(/missing its chatId param/);
  });
});

const remote = (over: Record<string, unknown> = {}) => ({
  page: 'chat' as const,
  id: 'c9',
  seq: 5,
  surfaceId: 'desk',
  updatedAt: 100,
  ...over,
});

describe('ViewPositionSync', () => {
  const send = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    __resetRouterMock();
    __setCurrentRoute('chats/[chatId]', { chatId: 'c1' });
    resetViewPositionSync();
    send.mockClear();
    vi.mocked(getWs).mockReturnValue({ send } as unknown as ReturnType<typeof getWs>);
    useViewPositionStore.setState({ remote: null, handledAt: 0, scroll: null });
    usePresenceStore.setState({ surfaceId: 'phone' });
    seedSettings();
  });
  // Each test's component stays subscribed to the stores until unmounted, and a
  // stale one would act on the next test's snapshot.
  const mounted: ReturnType<typeof renderRN>[] = [];
  const mount = (): ReturnType<typeof renderRN> => {
    const view = renderRN(<ViewPositionSync />);
    mounted.push(view);
    return view;
  };
  afterEach(() => {
    for (const view of mounted.splice(0)) actSync(() => view.unmount());
    vi.useRealTimers();
  });

  it('adopts the other surface position when the launch snapshot arrives', () => {
    mount();
    actSync(() => useViewPositionStore.getState().applyUpdated(remote(), 'phone'));
    expect(routerMock.navigate).toHaveBeenCalledWith('/chats/c9?seq=5');
  });

  it('neither adopts nor reports while "Sync position" is off', () => {
    const fx = settingsFixture();
    useSettingsStore.setState({
      data: { ...fx, preferences: { ...fx.preferences, syncPosition: false } },
    });
    mount();
    actSync(() => noteUserInput());
    actSync(() => useViewPositionStore.getState().setScroll('c1', 3));
    actSync(() => vi.advanceTimersByTime(VIEW_POSITION_DEBOUNCE_MS + 1));
    expect(send).not.toHaveBeenCalled();
    actSync(() => __emitAppStateChange('background'));
    actSync(() => useViewPositionStore.getState().applyUpdated(remote(), 'phone'));
    actSync(() => __emitAppStateChange('active'));
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  it("ignores its own surface's echo", () => {
    mount();
    actSync(() =>
      useViewPositionStore.getState().applyUpdated(remote({ surfaceId: 'phone' }), 'phone'),
    );
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  it('does not move a screen in use; adopts on returning to the foreground', () => {
    mount();
    actSync(() => noteUserInput());
    actSync(() => useViewPositionStore.getState().applyUpdated(remote(), 'phone'));
    expect(routerMock.navigate).not.toHaveBeenCalled();
    actSync(() => __emitAppStateChange('background'));
    actSync(() => __emitAppStateChange('active'));
    expect(routerMock.navigate).toHaveBeenCalledWith('/chats/c9?seq=5');
    actSync(() => __emitAppStateChange('active'));
    expect(routerMock.navigate).toHaveBeenCalledTimes(1);
  });

  it('a notification tap or deep link wins over the foreground handover', () => {
    mount();
    actSync(() => noteUserInput());
    actSync(() => useViewPositionStore.getState().applyUpdated(remote(), 'phone'));
    actSync(() => __emitAppStateChange('background'));
    actSync(() => noteExplicitNavigation());
    actSync(() => __emitAppStateChange('active'));
    expect(routerMock.navigate).not.toHaveBeenCalled();
    // Nor does the same remote position come back on the next foreground.
    actSync(() => vi.advanceTimersByTime(EXPLICIT_NAV_HOLD_MS + 1));
    actSync(() => __emitAppStateChange('background'));
    actSync(() => __emitAppStateChange('active'));
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  it('a launch snapshot arriving after a cold-start notification tap is not adopted', () => {
    mount();
    actSync(() => noteExplicitNavigation());
    actSync(() => vi.advanceTimersByTime(EXPLICIT_NAV_HOLD_MS + 1));
    actSync(() => useViewPositionStore.getState().applyUpdated(remote(), 'phone'));
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  it('reports nothing before use, then the page and scroll seq', () => {
    mount();
    actSync(() => vi.advanceTimersByTime(VIEW_POSITION_DEBOUNCE_MS + 1));
    expect(send).not.toHaveBeenCalled();
    actSync(() => noteUserInput());
    actSync(() => useViewPositionStore.getState().setScroll('c1', 33));
    actSync(() => vi.advanceTimersByTime(VIEW_POSITION_DEBOUNCE_MS + 1));
    expect(send).toHaveBeenCalledWith({
      type: 'view_position.set',
      page: 'chat',
      id: 'c1',
      seq: 33,
    });
  });

  it('reports the open chat on first touch even when nothing else changes', () => {
    mount();
    actSync(() => vi.advanceTimersByTime(VIEW_POSITION_DEBOUNCE_MS + 1));
    expect(send).not.toHaveBeenCalled();
    // Same chat, no navigation, no scroll: the touch alone makes it the live position.
    actSync(() => noteUserInput());
    actSync(() => vi.advanceTimersByTime(VIEW_POSITION_DEBOUNCE_MS + 1));
    expect(send).toHaveBeenCalledWith({ type: 'view_position.set', page: 'chat', id: 'c1' });
  });

  it('reports a job editor with its id param', () => {
    __setCurrentRoute('settings/job-editor', { id: 'j1' });
    mount();
    actSync(() => noteUserInput());
    actSync(() => vi.advanceTimersByTime(VIEW_POSITION_DEBOUNCE_MS + 1));
    expect(send).toHaveBeenCalledWith({ type: 'view_position.set', page: 'job', id: 'j1' });
  });

  it('follows the container: a state event moves the reported page', () => {
    mount();
    actSync(() => noteUserInput());
    actSync(() => {
      __setCurrentRoute('jobs');
      __emitNavigationEvent('state');
    });
    actSync(() => vi.advanceTimersByTime(VIEW_POSITION_DEBOUNCE_MS + 1));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: 'view_position.set', page: 'jobs' });
  });

  it('waits for the navigator: nothing is adopted until it is ready, then it is', () => {
    __setRootNavigationReady(false);
    mount();
    actSync(() => useViewPositionStore.getState().applyUpdated(remote(), 'phone'));
    expect(routerMock.navigate).not.toHaveBeenCalled();
    actSync(() => {
      __setRootNavigationReady(true);
      __emitNavigationEvent('ready');
    });
    expect(routerMock.navigate).toHaveBeenCalledWith('/chats/c9?seq=5');
  });

  it('stops listening to the container when it unmounts', () => {
    const view = mount();
    expect(__navigationListenerCount()).toBeGreaterThan(0);
    actSync(() => view.unmount());
    expect(__navigationListenerCount()).toBe(0);
  });

  it('reports nothing while no screen is focused, and a repeated event changes nothing', () => {
    __setCurrentRoute();
    mount();
    actSync(() => noteUserInput());
    actSync(() => __emitNavigationEvent('state'));
    actSync(() => vi.advanceTimersByTime(VIEW_POSITION_DEBOUNCE_MS + 1));
    expect(send).not.toHaveBeenCalled();
  });
});
