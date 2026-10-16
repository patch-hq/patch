// Pads on the phone (spec/14 § Pads): the list, the Pad screen with its editor
// WebView, and a Pad card opening the Pad instead of the artifact viewer.

import React from 'react';
import { act } from 'react-test-renderer';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  renderRN,
  findHost,
  queryHost,
  byTestId,
  hasText,
  actAsync,
  flush,
} from './testUtils/render';
import PadsScreen, { PADS_POLL_MS } from '../app/pads/index';
import PadScreen from '../app/pads/[padId]';
import { api, type PadView } from '../src/api/rest';
import { setRoute } from '../src/config';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { routerMock, __resetRouterMock, __setLocalSearchParams } from './stubs/expo-router';
import { __getLastAlert, __clearLastAlert } from './stubs/react-native';
import { __clearAllMmkv, TEST_SERVER_URL } from './stubs/mmkv';

vi.mock('../src/api/rest', () => ({
  api: { listPads: vi.fn(), getPad: vi.fn(), patchPad: vi.fn(), deletePad: vi.fn() },
}));

const pad = (over: Partial<PadView> = {}): PadView => ({
  id: 'p1',
  name: 'Home screen',
  app: 'Patch',
  chatId: 'c1',
  device: 'phone',
  createdAt: 1,
  updatedAt: Date.now() - 60_000,
  pending: 2,
  working: false,
  screens: [],
  screensError: null,
  frameUrl: '/api/padx/p1/sig/',
  ...over,
});

type R = ReturnType<typeof renderRN>;
const mounted: R[] = [];
const mount = async (el: React.ReactElement): Promise<R> => {
  const r = renderRN(el);
  mounted.push(r);
  await flush();
  return r;
};
const get = (r: R, id: string) => findHost(r.root, byTestId(id));
const press = async (r: R, id: string) => {
  await actAsync(() => {
    get(r, id).props['onPress']();
  });
  await flush();
};

beforeEach(() => {
  __clearAllMmkv();
  __resetRouterMock();
  __clearLastAlert();
  __setLocalSearchParams({ padId: 'p1' });
  useChatStore.getState()._reset();
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      name: 'Design chat',
      folder: '~/p',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
    },
  ]);
  useUiStore.setState({ errors: [] });
  vi.mocked(api.listPads)
    .mockReset()
    .mockResolvedValue({ pads: [pad()] });
  vi.mocked(api.getPad).mockReset().mockResolvedValue(pad());
  vi.mocked(api.patchPad)
    .mockReset()
    .mockResolvedValue(pad({ name: 'Renamed' }));
  vi.mocked(api.deletePad).mockReset().mockResolvedValue(null);
});
afterEach(() => {
  vi.useRealTimers();
  for (const r of mounted.splice(0)) {
    try {
      act(() => r.unmount());
    } catch {
      // already unmounted
    }
  }
});

describe('Pads list', () => {
  it('groups pads by app with chat name and badge, and a row opens the Pad', async () => {
    vi.mocked(api.listPads).mockResolvedValue({
      pads: [pad(), pad({ id: 'p2', name: 'Blank', app: null, pending: 0, working: true })],
    });
    const r = await mount(<PadsScreen />);
    expect(hasText(get(r, 'pads-group-Patch'), 'Home screen')).toBe(true);
    expect(hasText(get(r, 'pads-group-Patch'), 'Design chat')).toBe(true);
    expect(hasText(get(r, 'pad-badge-p1'), '2 changes')).toBe(true);
    expect(hasText(get(r, 'pad-badge-p2'), 'Working')).toBe(true);
    expect(get(r, 'pads-group-No app')).toBeTruthy();
    await press(r, 'pad-row-p1');
    expect(routerMock.push).toHaveBeenCalledWith('/pads/p1');
  });

  it('search narrows the list; no match says so', async () => {
    const r = await mount(<PadsScreen />);
    await actAsync(() => get(r, 'pads-search').props['onChangeText']('nothing'));
    expect(hasText(get(r, 'pads-empty'), 'No pads match.')).toBe(true);
  });

  it('says there are none, and hides search', async () => {
    vi.mocked(api.listPads).mockResolvedValue({ pads: [] });
    const r = await mount(<PadsScreen />);
    expect(hasText(get(r, 'pads-empty'), 'No pads yet.')).toBe(true);
    expect(queryHost(r.root, byTestId('pads-search'))).toBeNull();
  });

  it('a failed load is said, with Retry', async () => {
    vi.mocked(api.listPads).mockRejectedValueOnce(new Error('down'));
    const r = await mount(<PadsScreen />);
    expect(hasText(get(r, 'pads-error'), 'Failed to load pads: down')).toBe(true);
    await actAsync(() =>
      findHost(r.root, (i) => i.props?.accessibilityLabel === 'Retry').props['onPress'](),
    );
    await flush();
    expect(queryHost(r.root, byTestId('pads-error'))).toBeNull();
  });

  it('polls, and back goes to the previous screen', async () => {
    vi.useFakeTimers();
    const r = renderRN(<PadsScreen />);
    mounted.push(r);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PADS_POLL_MS * 2 + 1);
    });
    expect(api.listPads).toHaveBeenCalledTimes(3);
    act(() => get(r, 'pads-back').props['onPress']());
    expect(routerMock.back).toHaveBeenCalled();
  });
});

describe('Pad screen', () => {
  it('loads the editor from the signed frame url under the server origin', async () => {
    const r = await mount(<PadScreen />);
    expect(api.getPad).toHaveBeenCalledWith('p1');
    expect(get(r, 'pad-webview').props['source'].uri).toBe(`${TEST_SERVER_URL}/api/padx/p1/sig/`);
    expect(hasText(get(r, 'pad-screen'), 'Design chat')).toBe(true);
    expect(hasText(get(r, 'pad-screen'), '2 changes')).toBe(true);
  });

  it('over a relay it says the editor needs a direct connection, with no frame', async () => {
    setRoute({ kind: 'relay', relay: { url: 'wss://r.example', channel: 'c', serverKey: 'k' } });
    const r = await mount(<PadScreen />);
    expect(get(r, 'pad-relayed')).toBeTruthy();
    expect(queryHost(r.root, byTestId('pad-webview'))).toBeNull();
  });

  it('shows the screens error instead of a frame', async () => {
    vi.mocked(api.getPad).mockResolvedValue(pad({ screensError: 'bad manifest' }));
    const r = await mount(<PadScreen />);
    expect(hasText(get(r, 'pad-screens-error'), 'bad manifest')).toBe(true);
    expect(queryHost(r.root, byTestId('pad-webview'))).toBeNull();
  });

  it('says so when the Pad cannot be loaded', async () => {
    vi.mocked(api.getPad).mockRejectedValue(new Error('gone'));
    const r = await mount(<PadScreen />);
    expect(hasText(get(r, 'pad-error'), 'Failed to load this pad: gone')).toBe(true);
  });

  it('renames on submit, ignoring an empty or unchanged name', async () => {
    const r = await mount(<PadScreen />);
    await press(r, 'pad-name');
    await actAsync(() => get(r, 'pad-name-input').props['onChangeText']('Renamed'));
    await actAsync(() => get(r, 'pad-name-input').props['onSubmitEditing']());
    expect(api.patchPad).toHaveBeenCalledWith('p1', { name: 'Renamed' });
    expect(hasText(get(r, 'pad-name'), 'Renamed')).toBe(true);

    await press(r, 'pad-name');
    await actAsync(() => get(r, 'pad-name-input').props['onChangeText']('   '));
    await actAsync(() => get(r, 'pad-name-input').props['onBlur']());
    expect(api.patchPad).toHaveBeenCalledTimes(1);
  });

  it('reports a failed rename', async () => {
    vi.mocked(api.patchPad).mockRejectedValue(new Error('nope'));
    const r = await mount(<PadScreen />);
    await press(r, 'pad-name');
    await actAsync(() => get(r, 'pad-name-input').props['onChangeText']('X'));
    await actAsync(() => get(r, 'pad-name-input').props['onSubmitEditing']());
    expect(useUiStore.getState().errors.some((e) => e.message.includes('nope'))).toBe(true);
  });

  it('opens the owning chat', async () => {
    const r = await mount(<PadScreen />);
    await press(r, 'pad-open-chat');
    expect(routerMock.push).toHaveBeenCalledWith('/chats/c1');
  });

  it('Delete is confirmed, then deletes and goes back; a failure is reported', async () => {
    const r = await mount(<PadScreen />);
    await press(r, 'pad-delete');
    const alert = __getLastAlert()!;
    expect(api.deletePad).not.toHaveBeenCalled();
    await actAsync(() => alert.buttons!.find((b) => b.style === 'destructive')!.onPress!());
    await flush();
    expect(api.deletePad).toHaveBeenCalledWith('p1');
    expect(routerMock.back).toHaveBeenCalled();

    vi.mocked(api.deletePad).mockRejectedValueOnce(new Error('locked'));
    await press(r, 'pad-delete');
    await actAsync(() =>
      __getLastAlert()!.buttons!.find((b) => b.style === 'destructive')!.onPress!(),
    );
    await flush();
    expect(useUiStore.getState().errors.some((e) => e.message.includes('locked'))).toBe(true);
  });

  it('polls the Pad so badges follow edits', async () => {
    vi.useFakeTimers();
    const r = renderRN(<PadScreen />);
    mounted.push(r);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5001);
    });
    expect(api.getPad).toHaveBeenCalledTimes(2);
    act(() => get(r, 'pad-back').props['onPress']());
    expect(routerMock.back).toHaveBeenCalled();
  });
});
