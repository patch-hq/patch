// Move page (spec/04 § Moving to another host, spec/15 § Chat detail → Move
// to…): the other hosts, the same-named folder offered; moving opens the
// linked chat's draft on the new-chat screen, and a refusal is kept on screen
// with the server's reason.

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderRN, findHost, byTestId, hasText, flush, actSync } from './testUtils/render';
import ChatMove from '../app/chats/[chatId]/move';
import { __resetRouterMock, __setLocalSearchParams, routerMock } from './stubs/expo-router';
import { useChatStore } from '../src/stores/chatStore';
import { useFolderStore } from '../src/stores/folderStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { ApiError } from '../src/api/rest';
import { useNewChatDraftStore } from '../src/stores/newChatDraftStore';

const { moveSpy } = vi.hoisted(() => ({ moveSpy: vi.fn() }));
vi.mock('../src/api/rest', async (orig) => ({
  ...(await orig<typeof import('../src/api/rest')>()),
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    moveChat: moveSpy,
  },
}));

function report(hostId: string, hostName: string): void {
  usePresenceStore.getState().setHostReport({
    type: 'host.host',
    hostId,
    hostName,
    platform: 'linux',
    arch: 'x64',
    hostVersion: '0.1.400',
    updateAvailable: false,
    permissionModeDefault: 'default',
    permissionOverrides: 0,
    runsManager: false,
    backends: [],
    components: [],
  });
  usePresenceStore.getState().setHostOnline(hostId, true);
}

const press = (root: Parameters<typeof findHost>[0], id: string): void =>
  actSync(() => {
    (findHost(root, byTestId(id)).props.onPress as () => void)();
  });

describe('Chat Move screen', () => {
  beforeEach(() => {
    __resetRouterMock();
    moveSpy.mockReset();
    usePresenceStore.setState({ hosts: {} });
    useFolderStore.getState()._reset();
    useChatStore.getState()._reset();
    report('mac', 'Mac');
    report('box', 'Hetzner');
    useFolderStore.getState().setAllFolders([
      { hostId: 'mac', roots: ['/Users/tom/wpp/Unite'], recent: [] },
      { hostId: 'box', roots: [], recent: ['/home/tom/projects', '/home/tom/Unite'] },
    ]);
    useChatStore
      .getState()
      .applyEvents([
        { type: 'chat.spawned', chatId: 'c1', hostId: 'mac', folder: '/Users/tom/wpp/Unite' },
      ]);
    __setLocalSearchParams({ chatId: 'c1' });
  });

  it('offers every host, another one chosen, with its same-named folder filled in', () => {
    const r = renderRN(<ChatMove />);
    expect(hasText(findHost(r.root, byTestId('move-from')), 'Mac · /Users/tom/wpp/Unite')).toBe(
      true,
    );
    expect(findHost(r.root, byTestId('move-host-mac'))).toBeTruthy();
    expect(findHost(r.root, byTestId('move-folder')).props.value).toBe('/home/tom/Unite');
  });

  it('keeps the path being typed when any host publishes its folders again', () => {
    const r = renderRN(<ChatMove />);
    actSync(() => {
      (findHost(r.root, byTestId('move-folder')).props.onChangeText as (t: string) => void)(
        '/srv/custom',
      );
    });
    expect(findHost(r.root, byTestId('move-folder')).props.value).toBe('/srv/custom');

    // The folder list is re-announced (this host's, or another's): same content.
    actSync(() => {
      useFolderStore.getState().setHostFolders({
        hostId: 'box',
        roots: [],
        recent: ['/home/tom/projects', '/home/tom/Unite'],
      });
    });
    expect(findHost(r.root, byTestId('move-folder')).props.value).toBe('/srv/custom');
  });

  it('moves by opening the linked chat’s draft on the new-chat screen', async () => {
    moveSpy.mockResolvedValue({
      draft: {
        id: 'draft-linked-7',
        hostId: 'box',
        folder: '/home/tom/Unite',
        text: 'This continues a chat',
        continuedFrom: 'c1',
        updatedAt: 1,
      },
    });
    const r = renderRN(<ChatMove />);
    press(r.root, 'move-confirm');
    await flush();
    expect(moveSpy).toHaveBeenCalledWith('c1', 'box', '/home/tom/Unite');
    expect(routerMock.replace).toHaveBeenCalledWith('/new-chat?draftId=draft-linked-7');
    expect(useNewChatDraftStore.getState().get('draft-linked-7')).toMatchObject({
      hostId: 'box',
      continuedFrom: 'c1',
    });
  });

  it('a refusal stays on the page and says why', async () => {
    moveSpy.mockRejectedValue(
      new ApiError(409, 'busy', { error: 'busy', message: 'Mac: this chat is mid-turn' }),
    );
    const r = renderRN(<ChatMove />);
    press(r.root, 'move-confirm');
    await flush();
    expect(hasText(findHost(r.root, byTestId('move-error')), 'Mac: this chat is mid-turn')).toBe(
      true,
    );
  });

  it('a folder from the list can be picked instead', () => {
    const r = renderRN(<ChatMove />);
    press(r.root, 'move-folder-option-/home/tom/projects');
    expect(findHost(r.root, byTestId('move-folder')).props.value).toBe('/home/tom/projects');
  });

  it('with no same-named folder, the first folder the host offers is selected', () => {
    useFolderStore.getState().setAllFolders([
      { hostId: 'mac', roots: ['/Users/tom/wpp/Unite'], recent: [] },
      { hostId: 'box', roots: [], recent: ['/home/tom/projects', '/home/tom/other'] },
    ]);
    const r = renderRN(<ChatMove />);
    expect(findHost(r.root, byTestId('move-folder')).props.value).toBe('/home/tom/projects');
  });

  it('a chat whose own host is offline is moved the same way, its same-named folder filled in', async () => {
    usePresenceStore.getState().setHostOnline('mac', false);
    const r = renderRN(<ChatMove />);
    expect(findHost(r.root, byTestId('move-folder')).props.value).toBe('/home/tom/Unite');
    expect(hasText(findHost(r.root, byTestId('move-confirm')), 'Move')).toBe(true);
  });
});
