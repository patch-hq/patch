// Handover (spec/05 § Handover): route <-> position mapping, and the phone's
// rule — it only changes screen while the user is not looking at it.

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
import { __clearAllMmkv } from './stubs/mmkv';
import { __runTask } from './stubs/expo-task-manager';
import {
  HANDOVER_TASK,
  LOG_LIMIT,
  defineHandoverTask,
  logDecision,
  positionFromPush,
  pushPayload,
  readHandledAt,
  readLog,
  readSyncEnabled,
  receiveHandoverPush,
  writeLast,
} from '../src/lib/handover';

vi.mock('../src/api/ws', () => ({ getWs: vi.fn() }));

import {
  ViewPositionSync,
  VIEW_POSITION_DEBOUNCE_MS,
  noteExplicitNavigation,
  noteUserInput,
  resetViewPositionSync,
  acceptOffer,
  dismissOffer,
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
  surfaceKind: 'desktop',
  updatedAt: 100,
  ...over,
});

// Over the socket: a live move, or the snapshot sent as it connects.
const arrive = (over: Record<string, unknown> = {}, snapshot = false): void =>
  useViewPositionStore.getState().applyUpdated(remote(over), snapshot);

// A silent push, as Expo hands it to the task: our data JSON under `body`.
const pushData = (over: Record<string, unknown> = {}): Record<string, string> => {
  const r = remote(over);
  return {
    kind: 'view_position',
    page: r.page,
    id: r.id as string,
    seq: String(r.seq),
    surfaceId: r.surfaceId as string,
    surfaceKind: r.surfaceKind as string,
    updatedAt: String(r.updatedAt),
  };
};

const putAway = (): void => __emitAppStateChange('background');
const pickUp = (): void => __emitAppStateChange('active');

describe('ViewPositionSync', () => {
  const send = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    __clearAllMmkv();
    __resetRouterMock();
    __setCurrentRoute('chats/[chatId]', { chatId: 'c1' });
    __emitAppStateChange('active');
    resetViewPositionSync();
    send.mockClear();
    vi.mocked(getWs).mockReturnValue({
      safeSend: send,
      send: () => {
        throw new Error('PatchWs: not connected');
      },
    } as unknown as ReturnType<typeof getWs>);
    useViewPositionStore.setState({ remote: null, offer: null, scroll: null });
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

  // ---- Adopting ----

  it('a move that arrives while the phone is put away is applied at once', () => {
    mount();
    actSync(putAway);
    actSync(() => arrive());
    expect(routerMock.navigate).toHaveBeenCalledWith('/chats/c9?seq=5');
    expect(readLog()[0]).toMatchObject({
      outcome: 'applied',
      via: 'socket',
      from: 'your computer',
    });
  });

  it('a move that arrives while the phone is in use is dropped, and stays dropped', () => {
    mount();
    actSync(() => noteUserInput());
    actSync(() => arrive());
    expect(routerMock.navigate).not.toHaveBeenCalled();
    expect(readHandledAt()).toBe(100);
    // Putting the phone away later does not bring it back.
    actSync(putAway);
    actSync(pickUp);
    expect(routerMock.navigate).not.toHaveBeenCalled();
    expect(readLog()[0]).toMatchObject({
      outcome: 'dropped',
      why: 'arrived while the phone was in use',
    });
  });

  it('a silent push moves a backgrounded phone, so it is already there when picked up', async () => {
    defineHandoverTask();
    mount();
    actSync(putAway);
    await __runTask(HANDOVER_TASK, { data: { body: JSON.stringify(pushData()) } });
    expect(routerMock.navigate).toHaveBeenCalledWith('/chats/c9?seq=5');
    expect(readLog()[0]).toMatchObject({ outcome: 'applied', via: 'push' });
    // The socket snapshot of the same move, on pick-up, changes nothing.
    actSync(pickUp);
    actSync(() => arrive({}, true));
    expect(routerMock.navigate).toHaveBeenCalledTimes(1);
    expect(useViewPositionStore.getState().offer).toBeNull();
  });

  it('a push to a closed app is kept, and the next launch opens straight onto it before the socket', async () => {
    defineHandoverTask();
    await __runTask(HANDOVER_TASK, { data: { body: JSON.stringify(pushData()) } });
    expect(readLog()[0]).toMatchObject({ outcome: 'stored' });
    mount();
    expect(routerMock.navigate).toHaveBeenCalledWith('/chats/c9?seq=5');
    expect(readLog()[0]).toMatchObject({ outcome: 'applied', via: 'launch' });
  });

  it('a launch for a notification tap does not replace the screen asked for', () => {
    writeLast(remote());
    noteExplicitNavigation();
    mount();
    expect(routerMock.navigate).not.toHaveBeenCalled();
    expect(readLog()[0]).toMatchObject({ outcome: 'dropped', via: 'launch' });
  });

  it("a launch reopens the phone's own last place", () => {
    writeLast(
      remote({
        surfaceId: 'phone',
        surfaceKind: 'mobile',
        page: 'jobs',
        id: undefined,
        seq: undefined,
      }),
    );
    mount();
    expect(routerMock.navigate).toHaveBeenCalledWith('/jobs');
  });

  it("the phone's own report coming back is never a move", () => {
    mount();
    actSync(putAway);
    actSync(() => arrive({ surfaceId: 'phone' }));
    expect(routerMock.navigate).not.toHaveBeenCalled();
    expect(readHandledAt()).toBe(100);
  });

  it('an older position than one already applied is ignored', () => {
    mount();
    actSync(putAway);
    actSync(() => arrive({ updatedAt: 200, id: 'new' }));
    actSync(() => arrive({ updatedAt: 150, id: 'old' }));
    expect(routerMock.navigate).toHaveBeenCalledTimes(1);
    expect(routerMock.navigate).toHaveBeenCalledWith('/chats/new?seq=5');
  });

  it('waits for the navigator: a move taken while it is not ready is opened once it is', () => {
    __setRootNavigationReady(false);
    mount();
    actSync(putAway);
    actSync(() => arrive());
    expect(routerMock.navigate).not.toHaveBeenCalled();
    actSync(() => {
      __setRootNavigationReady(true);
      __emitNavigationEvent('ready');
    });
    expect(routerMock.navigate).toHaveBeenCalledWith('/chats/c9?seq=5');
  });

  // ---- Missed move ----

  it('a missed move is offered on pick-up, not taken; tapping goes there', () => {
    mount();
    actSync(putAway);
    actSync(pickUp);
    actSync(() => arrive({}, true));
    expect(routerMock.navigate).not.toHaveBeenCalled();
    expect(useViewPositionStore.getState().offer).toMatchObject({ id: 'c9' });
    actSync(() => acceptOffer((href) => routerMock.navigate(href)));
    expect(routerMock.navigate).toHaveBeenCalledWith('/chats/c9?seq=5');
    expect(useViewPositionStore.getState().offer).toBeNull();
  });

  it('a dismissed offer is gone for good', () => {
    mount();
    actSync(putAway);
    actSync(pickUp);
    actSync(() => arrive({}, true));
    actSync(() => dismissOffer('ran out'));
    expect(useViewPositionStore.getState().offer).toBeNull();
    expect(readLog()[0]).toMatchObject({ outcome: 'dropped', why: 'ran out' });
    actSync(putAway);
    actSync(pickUp);
    actSync(() => arrive({}, true));
    expect(useViewPositionStore.getState().offer).toBeNull();
  });

  it('a snapshot after the user has already touched the phone is not offered', () => {
    mount();
    actSync(putAway);
    actSync(pickUp);
    actSync(() => noteUserInput());
    actSync(() => arrive({}, true));
    expect(useViewPositionStore.getState().offer).toBeNull();
    expect(routerMock.navigate).not.toHaveBeenCalled();
  });

  it('a live move while in use is never offered', () => {
    mount();
    actSync(() => arrive({}, false));
    expect(useViewPositionStore.getState().offer).toBeNull();
  });

  it('putting the phone away clears an offer still on screen', () => {
    mount();
    actSync(putAway);
    actSync(pickUp);
    actSync(() => arrive({}, true));
    actSync(putAway);
    expect(useViewPositionStore.getState().offer).toBeNull();
  });

  // ---- Off ----

  it('neither adopts, offers nor reports while "Sync position" is off, and remembers it was off', () => {
    actSync(() =>
      useSettingsStore.setState({
        data: settingsFixture({ preferences: { syncPosition: false } }),
      }),
    );
    mount();
    actSync(putAway);
    actSync(() => arrive());
    expect(routerMock.navigate).not.toHaveBeenCalled();
    actSync(pickUp);
    actSync(() => noteUserInput());
    actSync(() => vi.advanceTimersByTime(VIEW_POSITION_DEBOUNCE_MS + 1));
    expect(send).not.toHaveBeenCalled();
    expect(readSyncEnabled()).toBe(false);
  });

  // ---- Reporting ----

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

  it('never sends the same place twice', () => {
    mount();
    actSync(() => noteUserInput());
    for (let i = 0; i < 5; i++) {
      actSync(() => useViewPositionStore.getState().setScroll('c1', null));
      actSync(() => vi.advanceTimersByTime(5000));
    }
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends where the user stopped as the phone is put away', () => {
    mount();
    actSync(() => noteUserInput());
    actSync(() => vi.advanceTimersByTime(VIEW_POSITION_DEBOUNCE_MS + 1));
    actSync(() => useViewPositionStore.getState().setScroll('c1', 12));
    actSync(putAway);
    expect(send).toHaveBeenLastCalledWith({
      type: 'view_position.set',
      page: 'chat',
      id: 'c1',
      seq: 12,
    });
  });

  it('does not send back a place it was moved to', () => {
    mount();
    actSync(putAway);
    actSync(() => arrive());
    __setCurrentRoute('chats/[chatId]', { chatId: 'c9' });
    actSync(() => __emitNavigationEvent('state'));
    actSync(() => useViewPositionStore.getState().setScroll('c9', 5));
    actSync(pickUp);
    actSync(() => noteUserInput());
    actSync(() => vi.advanceTimersByTime(VIEW_POSITION_DEBOUNCE_MS + 1));
    expect(send).not.toHaveBeenCalled();
  });

  it('does not throw from the debounce timer when the socket is down (#420, #421)', () => {
    mount();
    actSync(() => noteUserInput());
    expect(() =>
      actSync(() => vi.advanceTimersByTime(VIEW_POSITION_DEBOUNCE_MS + 1)),
    ).not.toThrow();
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

  it('stops listening to the container when it unmounts', () => {
    const view = mount();
    expect(__navigationListenerCount()).toBeGreaterThan(0);
    actSync(() => view.unmount());
    expect(__navigationListenerCount()).toBe(0);
  });

  it('reports nothing while no screen is focused', () => {
    __setCurrentRoute();
    mount();
    actSync(() => noteUserInput());
    actSync(() => __emitNavigationEvent('state'));
    actSync(() => vi.advanceTimersByTime(VIEW_POSITION_DEBOUNCE_MS + 1));
    expect(send).not.toHaveBeenCalled();
  });
});

describe('handover push data', () => {
  beforeEach(() => __clearAllMmkv());

  it('reads the position out of the payload Expo hands the task', () => {
    const data = pushData({ seq: 7 });
    expect(positionFromPush(pushPayload({ data: { body: JSON.stringify(data) } }))).toMatchObject({
      page: 'chat',
      id: 'c9',
      seq: 7,
      surfaceKind: 'desktop',
      updatedAt: 100,
    });
    expect(
      positionFromPush(pushPayload({ data: { dataString: JSON.stringify(data) } })),
    ).toMatchObject({ id: 'c9' });
    expect(positionFromPush(pushPayload({ data }))).toMatchObject({ id: 'c9' });
  });

  it('ignores pushes that are not handovers and refuses malformed ones', () => {
    expect(positionFromPush({ kind: 'message', chatId: 'x' })).toBeNull();
    expect(
      positionFromPush({ kind: 'view_position', page: 'nowhere', surfaceId: 's', updatedAt: '1' }),
    ).toBeNull();
  });

  it('counts pushes, and a push older than what was applied is dropped', () => {
    receiveHandoverPush(pushData({ updatedAt: 300 }));
    receiveHandoverPush(pushData({ updatedAt: 200 }));
    expect(readLog()[0]).toMatchObject({ outcome: 'stored' });
  });

  it('keeps only the last LOG_LIMIT decisions', () => {
    for (let i = 0; i < LOG_LIMIT + 5; i++)
      logDecision(remote({ updatedAt: i }), 'push', 'dropped', String(i));
    const log = readLog();
    expect(log).toHaveLength(LOG_LIMIT);
    expect(log[0]!.why).toBe(String(LOG_LIMIT + 4));
  });
});
