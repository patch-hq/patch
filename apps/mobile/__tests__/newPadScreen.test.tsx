// New Pad screen (spec/14 § Pads — Starting a Pad, way (c)), mirrored on the phone.

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
import NewPadScreen from '../app/pads/new';
import PadsScreen from '../app/pads/index';
import { api, type PadView } from '../src/api/rest';
import { setRoute } from '../src/config';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { routerMock, __resetRouterMock, __setLocalSearchParams } from './stubs/expo-router';
import { __clearAllMmkv, TEST_SERVER_URL } from './stubs/mmkv';

vi.mock('../src/api/rest', () => ({
  api: { padLibrary: vi.fn(), createPad: vi.fn(), listPads: vi.fn() },
}));

const chat = (chatId: string, name: string, lastUpdated: number, status = 'active') => ({
  chatId,
  name,
  folder: '~/p',
  activity: 'idle' as const,
  status: status as 'active',
  pinned: false,
  pinnedAt: null,
  lastUpdated,
});
const LIB = {
  apps: [
    {
      app: 'Yonder',
      screens: [
        {
          padId: 'p1',
          screenId: 's1',
          name: 'Home',
          thumbUrl: '/api/padx/p1/sig/thumb/s1.png?r=0',
          device: 'phone' as const,
        },
        { padId: 'p1', screenId: 's2', name: 'Map', thumbUrl: null, device: 'phone' as const },
      ],
    },
  ],
};

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
  await actAsync(() => get(r, id).props['onPress']());
  await flush();
};
const pickChat = async (r: R, id: string) => {
  await press(r, 'new-pad-chat');
  await press(r, `new-pad-chat-option-${id}`);
};
const type = async (r: R, id: string, v: string) => {
  await actAsync(() => get(r, id).props['onChangeText'](v));
};

beforeEach(() => {
  __clearAllMmkv();
  __resetRouterMock();
  __setLocalSearchParams({});
  setRoute({ kind: 'direct', url: TEST_SERVER_URL });
  useChatStore.getState()._reset();
  useChatStore
    .getState()
    .hydrate([chat('c1', 'Older', 1), chat('c2', 'Newer', 5), chat('c3', 'Gone', 9, 'archived')]);
  useUiStore.setState({ errors: [] });
  vi.mocked(api.padLibrary).mockReset().mockResolvedValue(LIB);
  vi.mocked(api.createPad)
    .mockReset()
    .mockResolvedValue({ id: 'new1', chatId: 'c1' } as PadView);
  vi.mocked(api.listPads).mockReset().mockResolvedValue({ pads: [] });
});
afterEach(() => {
  for (const r of mounted.splice(0)) {
    try {
      act(() => r.unmount());
    } catch {
      // already unmounted
    }
  }
});

describe('New Pad screen', () => {
  it('Create is disabled until there is a name and a chat', async () => {
    const r = await mount(<NewPadScreen />);
    expect(get(r, 'new-pad-create').props['disabled']).toBe(true);
    await type(r, 'new-pad-name', 'Idea');
    expect(get(r, 'new-pad-create').props['disabled']).toBe(true);
    await pickChat(r, 'c2');
    expect(get(r, 'new-pad-create').props['disabled']).toBe(false);
  });

  it('chat options exclude archived chats, newest first', async () => {
    const r = await mount(<NewPadScreen />);
    await press(r, 'new-pad-chat');
    expect(queryHost(r.root, byTestId('new-pad-chat-option-c3'))).toBeNull();
    expect(get(r, 'new-pad-chat-option-c2')).toBeTruthy();
  });

  it('creates a blank pad with the exact body and replaces to the new pad', async () => {
    const r = await mount(<NewPadScreen />);
    await type(r, 'new-pad-name', '  Idea ');
    await pickChat(r, 'c1');
    await press(r, 'new-pad-create');
    expect(api.createPad).toHaveBeenCalledWith({ name: 'Idea', device: 'desktop', chatId: 'c1' });
    expect(routerMock.replace).toHaveBeenCalledWith('/pads/new1');
  });

  it('based on an app with earlier captures and Phone sends app, device and from', async () => {
    const r = await mount(<NewPadScreen />);
    await type(r, 'new-pad-name', 'Idea');
    await pickChat(r, 'c1');
    await press(r, 'new-pad-based-Yonder');
    await press(r, 'new-pad-phone');
    await press(r, 'new-pad-lib-p1-s2');
    await press(r, 'new-pad-create');
    expect(api.createPad).toHaveBeenCalledWith({
      name: 'Idea',
      app: 'Yonder',
      device: 'phone',
      chatId: 'c1',
      from: [{ padId: 'p1', screenId: 's2' }],
    });
  });

  it('thumbnails load from the signed url', async () => {
    const r = await mount(<NewPadScreen />);
    await press(r, 'new-pad-based-Yonder');
    expect(get(r, 'new-pad-lib-thumb-p1-s1').props['source']).toEqual({
      uri: `${TEST_SERVER_URL}/api/padx/p1/sig/thumb/s1.png?r=0`,
    });
  });

  it('Patch offers only earlier captures (none yet shows no section)', async () => {
    const r = await mount(<NewPadScreen />);
    await press(r, 'new-pad-based-Patch');
    expect(queryHost(r.root, byTestId('new-pad-library'))).toBeNull();
  });

  it('shows the error and stays when create fails', async () => {
    vi.mocked(api.createPad).mockRejectedValue(new Error('no_such_chat'));
    const r = await mount(<NewPadScreen />);
    await type(r, 'new-pad-name', 'Idea');
    await pickChat(r, 'c1');
    await press(r, 'new-pad-create');
    expect(hasText(get(r, 'new-pad-error'), 'no_such_chat')).toBe(true);
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(get(r, 'new-pad-create').props['disabled']).toBe(false);
  });

  it('shows busy while creating', async () => {
    let resolve!: (p: PadView) => void;
    vi.mocked(api.createPad).mockReturnValue(new Promise((res) => (resolve = res)));
    const r = await mount(<NewPadScreen />);
    await type(r, 'new-pad-name', 'Idea');
    await pickChat(r, 'c1');
    await press(r, 'new-pad-create');
    expect(hasText(get(r, 'new-pad-create'), 'Creating…')).toBe(true);
    expect(get(r, 'new-pad-create').props['disabled']).toBe(true);
    await actAsync(() => resolve({ id: 'n', chatId: 'c1' } as PadView));
  });

  it('honours chatId and app params (Design a change to Chat)', async () => {
    __setLocalSearchParams({ chatId: 'c2', app: 'Patch' });
    const r = await mount(<NewPadScreen />);
    await type(r, 'new-pad-name', 'Chat tweak');
    await press(r, 'new-pad-create');
    expect(api.createPad).toHaveBeenCalledWith({
      name: 'Chat tweak',
      app: 'Patch',
      device: 'desktop',
      chatId: 'c2',
    });
  });

  it('a library load failure is said', async () => {
    vi.mocked(api.padLibrary).mockRejectedValue(new Error('down'));
    const r = await mount(<NewPadScreen />);
    expect(hasText(get(r, 'new-pad-error'), 'down')).toBe(true);
  });
});

describe('Pads list New action', () => {
  it('routes to the New Pad screen', async () => {
    const r = await mount(<PadsScreen />);
    await press(r, 'pads-new');
    expect(routerMock.push).toHaveBeenCalledWith('/pads/new');
  });
});
