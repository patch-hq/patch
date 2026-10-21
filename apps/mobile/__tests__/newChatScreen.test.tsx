import { StyleSheet } from 'react-native';
// app/new-chat.tsx — type-first new chat (spec/15 § New chat flow, parity
// with web's new chat, spec/14 § Sidebar §8). Pins:
//   - the screen opens on the most recently used (host, folder) pair, shown in
//     one `<folder> · <host>` pill, with the recent-model quick picks
//   - the pill opens the folder picker sheet: one search box, recents with a
//     host tag, host chips only with several hosts, path mode on `/` or `~`,
//     and Browse… into the host's tree; a browse error is shown, never an
//     empty tree; picking a folder picks its host, an offline host is refused
//   - NOTHING is created until the first send; that send creates the chat
//     (POST /api/chats with only what the user chose), sends the message into
//     it through the ordinary composer path, and navigates into it
//   - a failed create keeps the draft and says why; an attachment send
//     navigates at once and its upload runs on in the new chat (spec/15 §
//     Composer → Attachments), a failed upload staying there as Not uploaded
//   - leaving without sending creates nothing and deletes nothing

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  renderRN,
  actAsync,
  actSync,
  flush,
  findHost,
  findAllHost,
  byTestId,
  byLabel,
  byType,
  hasText,
  textOf,
} from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { useSettingsStore } from '../src/stores/settingsStore';
import { useFolderStore } from '../src/stores/folderStore';
import { usePresenceStore, type HostPresence } from '../src/stores/presenceStore';
import { useUiStore } from '../src/stores/uiStore';
import { useComposerAttachmentStore } from '../src/stores/composerAttachmentStore';
import { deliveryTracker } from '../src/lib/deliveryTracker';
import { _resetSendQueue } from '../src/lib/sendQueue';
import { NEW_CHAT_DRAFT_KEY } from '../src/lib/newChat';
import { loadLastNewChat, saveLastNewChat } from '../src/lib/lastNewChat';
import { getComposerDraft, setComposerDraft } from '../src/lib/composerDraft';
import { routerMock, __resetRouterMock, __setLocalSearchParams } from './stubs/expo-router';
import { __clearAllMmkv } from './stubs/mmkv';
import type { ChatRow } from '../src/stores/types';

const { api, ApiErrorClass } = vi.hoisted(() => {
  class ApiErrorClass extends Error {
    readonly status: number;
    readonly body: unknown;
    constructor(status: number, message: string, body: unknown) {
      super(message);
      this.status = status;
      this.body = body;
    }
  }
  return {
    ApiErrorClass,
    api: {
      browseFolders: vi.fn(),
      createChat: vi.fn(),
      models: vi.fn(),
      deleteChat: vi.fn(),
      uploadAttachment: vi.fn(),
      skills: vi.fn(),
    },
  };
});
vi.mock('../src/api/rest', () => ({ api, ApiError: ApiErrorClass }));
const wsSend = vi.fn();
vi.mock('../src/api/ws', () => ({
  getWs: () => ({ send: wsSend, safeSend: vi.fn(), requestReplay: vi.fn() }),
}));

import NewChat from '../app/new-chat';

const HOST = 'd1';
const OTHER = 'd2';

function host(hostId: string, online = true, extra: Record<string, unknown> = {}): HostPresence {
  return {
    hostId,
    online,
    lastSeenAt: 1,
    host: { hostName: `${hostId}-box`, permissionModeDefault: 'default', ...extra },
    accounts: {},
  } as unknown as HostPresence;
}

function chat(partial: Partial<ChatRow> & { chatId: string }): ChatRow {
  return {
    name: null,
    preview: null,
    hostId: HOST,
    folder: '',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 1,
    model: null,
    jobId: null,
    ...partial,
  } as ChatRow;
}

let submitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __clearAllMmkv();
  __resetRouterMock();
  __setLocalSearchParams({});
  useChatStore.getState()._reset();
  _resetSendQueue();
  useFolderStore.getState()._reset();
  useComposerAttachmentStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    hosts: { [HOST]: host(HOST) },
  });
  for (const f of Object.values(api)) f.mockReset();
  api.models.mockResolvedValue({
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { id: 'claude-haiku-5', label: 'Claude Haiku 5' },
      { id: 'claude-opus-4', label: 'Claude Opus 4' },
    ],
  });
  api.browseFolders.mockResolvedValue({ dir: null, parent: null, entries: [] });
  api.createChat.mockResolvedValue({ chatId: 'chat_new', folder: '/p/one', status: 'pending' });
  api.deleteChat.mockResolvedValue({ ok: true });
  api.skills.mockResolvedValue({ skills: [] });
  wsSend.mockReset();
  submitSpy = vi.spyOn(deliveryTracker, 'submit').mockImplementation(() => {});
});

afterEach(() => {
  submitSpy.mockRestore();
});

async function renderReady(): Promise<ReturnType<typeof renderRN>> {
  let r!: ReturnType<typeof renderRN>;
  await actAsync(async () => {
    r = renderRN(<NewChat />);
    await flush();
  });
  return r;
}

async function press(r: ReturnType<typeof renderRN>, testID: string): Promise<void> {
  await actAsync(async () => {
    findHost(r.root, byTestId(testID)).props.onPress();
    await flush();
  });
}

function typeText(r: ReturnType<typeof renderRN>, text: string): void {
  actSync(() => findHost(r.root, byType('TextInput')).props.onChangeText(text));
}

async function send(r: ReturnType<typeof renderRN>): Promise<void> {
  await actAsync(async () => {
    const btn = findHost(r.root, (i) =>
      String(i.props['accessibilityLabel'] ?? '').startsWith('Send'),
    );
    btn.props.onPress();
    await flush();
    await flush();
  });
}

const pillText = (r: ReturnType<typeof renderRN>): string =>
  textOf(findHost(r.root, byTestId('new-chat-folder-pill')));

async function openSheet(r: ReturnType<typeof renderRN>): Promise<void> {
  await press(r, 'new-chat-folder-pill');
}

function searchSheet(r: ReturnType<typeof renderRN>, text: string): void {
  actSync(() => findHost(r.root, byTestId('folder-sheet-search')).props.onChangeText(text));
}

const sheetRows = (r: ReturnType<typeof renderRN>): string[] =>
  findAllHost(r.root, (i) => String(i.props['testID'] ?? '').startsWith('folder-sheet-row-')).map(
    (i) => String(i.props.testID).replace('folder-sheet-row-', ''),
  );

const selected = (r: ReturnType<typeof renderRN>, testID: string): boolean =>
  findHost(r.root, byTestId(testID)).props.accessibilityState?.selected === true;

describe('NewChat — setup quick picks', () => {
  it('fills the chosen folder pill and model dropdown solid so the choice is unmistakable', async () => {
    saveLastNewChat({
      hostId: HOST,
      folder: '/p/mine',
      model: 'claude-sonnet-5',
      permissionMode: 'plan',
    });
    const r = await renderReady();
    const bg = (id: string): unknown =>
      StyleSheet.flatten(findHost(r.root, byTestId(id)).props.style).backgroundColor;
    expect(bg('new-chat-folder-pill')).toBe('#46802f');
    expect(bg('new-chat-model-quick-claude-sonnet-5')).toBe('#46802f');
    expect(bg('new-chat-model-pill')).toBe('#46802f');
  });

  // Todoist 6hhj229445J7cG36: the options for a new chat are whatever the last
  // NEW chat used — not the newest activity anywhere, and never moving while
  // the screen is showing.
  it('opens on what the last new chat used, not the newest chat activity', async () => {
    saveLastNewChat({
      hostId: HOST,
      folder: '/p/mine',
      model: 'claude-sonnet-5',
      permissionMode: 'plan',
    });
    useChatStore.setState({
      chats: {
        b: chat({ chatId: 'b', folder: '/p/latest', lastUpdated: 5, model: 'claude-opus-4' }),
      },
    });
    const r = await renderReady();
    expect(pillText(r)).toBe('mine · d1-box');
    expect(selected(r, 'new-chat-model-quick-claude-sonnet-5')).toBe(true);
    expect(textOf(findHost(r.root, byTestId('new-chat-permission-mode')))).toBe('Plan only');
  });

  it('does not carry Auto onto a model that cannot run it: the pill reads the host default and none is sent', async () => {
    saveLastNewChat({
      hostId: HOST,
      folder: '/p/mine',
      model: 'claude-haiku-4-5',
      permissionMode: 'auto',
    });
    const r = await renderReady();
    expect(textOf(findHost(r.root, byTestId('new-chat-permission-mode')))).toBe(
      'Ask before acting',
    );
    typeText(r, 'go');
    await send(r);
    const payload = api.createChat.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload['model']).toBe('claude-haiku-4-5');
    expect(payload).not.toHaveProperty('permissionMode');
  });

  it('without a last new chat, existing chats do not choose a folder', async () => {
    useChatStore.setState({
      chats: { b: chat({ chatId: 'b', folder: '/p/latest', lastUpdated: 5 }) },
    });
    const r = await renderReady();
    expect(pillText(r)).toBe('Choose a folder…');
  });

  it('nothing changing in the chat list while it is open moves the options', async () => {
    saveLastNewChat({ hostId: HOST, folder: '/p/mine', model: null, permissionMode: null });
    useChatStore.setState({
      chats: { a: chat({ chatId: 'a', folder: '/p/one', model: 'claude-opus-4', lastUpdated: 1 }) },
    });
    const r = await renderReady();
    const picks = (): unknown[] =>
      findAllHost(r.root, (i) =>
        String(i.props['testID'] ?? '').startsWith('new-chat-model-quick-'),
      ).map((i) => i.props.testID);
    const before = picks();
    await actAsync(async () => {
      useChatStore.setState({
        chats: {
          a: chat({ chatId: 'a', folder: '/p/one', model: 'claude-opus-4', lastUpdated: 1 }),
          h: chat({ chatId: 'h', folder: '/p/hidden', model: 'claude-haiku-5', lastUpdated: 99 }),
        },
      });
      await flush();
    });
    expect(picks()).toEqual(before);
    expect(pillText(r)).toBe('mine · d1-box');
  });

  it('creating a new chat records its host, folder, model and mode as the next default', async () => {
    useFolderStore.getState().setHostFolders({ hostId: HOST, roots: ['/p/one'], recent: [] });
    __setLocalSearchParams({ hostId: HOST, folder: '/p/one' });
    const r = await renderReady();
    await press(r, 'new-chat-model-quick-claude-sonnet-5');
    typeText(r, 'hello');
    await send(r);
    expect(loadLastNewChat()).toEqual({
      hostId: HOST,
      folder: '/p/one',
      model: 'claude-sonnet-5',
      permissionMode: null,
    });
  });

  it('merely viewing or backing out records nothing', async () => {
    __setLocalSearchParams({ hostId: HOST, folder: '/p/one' });
    await renderReady();
    expect(loadLastNewChat()).toBeNull();
  });

  it('opens on the host + folder it was handed (chat detail ⋯ → New chat), creating nothing', async () => {
    useChatStore.setState({
      chats: { b: chat({ chatId: 'b', folder: '/p/latest', lastUpdated: 5 }) },
    });
    __setLocalSearchParams({ hostId: HOST, folder: '/p/here' });
    const r = await renderReady();
    expect(pillText(r)).toBe('here · d1-box');
    expect(api.createChat).not.toHaveBeenCalled();
  });

  it('with no chats the pill invites a choice and no folder is chosen', async () => {
    useFolderStore.getState().setHostFolders({ hostId: HOST, roots: ['/p/root1'], recent: [] });
    const r = await renderReady();
    expect(pillText(r)).toBe('Choose a folder…');
  });

  it('model picks: models this host has used first, topped up from the catalogue head', async () => {
    useChatStore.setState({
      chats: { a: chat({ chatId: 'a', folder: '/p/one', model: 'claude-opus-4' }) },
    });
    const r = await renderReady();
    const ids = findAllHost(r.root, (i) =>
      String(i.props['testID'] ?? '').startsWith('new-chat-model-quick-'),
    ).map((i) => i.props.testID);
    expect(ids).toEqual([
      'new-chat-model-quick-claude-opus-4',
      'new-chat-model-quick-claude-opus-5-5',
      'new-chat-model-quick-claude-sonnet-5',
    ]);
    expect(
      hasText(findHost(r.root, byTestId('new-chat-model-quick-claude-opus-4')), 'Opus 4'),
    ).toBe(true);
  });

  // Todoist: "the model select drop-down opens up in the wrong place when
  // you've got fresh new chat — it opens up where it would be in the sidebar
  // thing". The list dropped from under the header, where the chat kebab menu
  // opens, rather than over the composer the way the Permissions list right
  // below it does.
  it('the model pill opens its list over the composer, not under the header', async () => {
    const r = await renderReady();
    await press(r, 'new-chat-model-pill');
    const list = findHost(r.root, byTestId('model-picker-list'));
    expect(list.props.style.bottom).toEqual(expect.any(Number));
    expect(list.props.style.top).toBeUndefined();
  });

  it('model picks lead with the last model the USER chose, not a newer job chat or thread', async () => {
    useChatStore.setState({
      chats: {
        a: chat({ chatId: 'a', folder: '/p/one', model: 'claude-opus-4', lastUpdated: 1 }),
        j: chat({
          chatId: 'jobchat-nightly',
          folder: '/p/one',
          model: 'claude-haiku-5',
          lastUpdated: 9,
          jobId: 'nightly',
        }),
        m: chat({
          chatId: 'thread_manager',
          folder: '/home/tom/.patch/threads/manager',
          model: 'claude-sonnet-5',
          lastUpdated: 8,
        }),
      },
    });
    const r = await renderReady();
    const ids = findAllHost(r.root, (i) =>
      String(i.props['testID'] ?? '').startsWith('new-chat-model-quick-'),
    ).map((i) => i.props.testID);
    expect(ids).toEqual([
      'new-chat-model-quick-claude-opus-4',
      'new-chat-model-quick-claude-opus-5-5',
      'new-chat-model-quick-claude-sonnet-5',
    ]);
  });

  // Todoist 6hfFww7fH7JQFWj4 ("the options, model and workspace ... should
  // be at the bottom of the window, instead of at the top"): the picks used
  // to sit in a ScrollView directly under the header. They now dock right
  // above the composer, behind an empty flex:1 spacer that takes the space a
  // real chat's transcript would occupy — so document order (which this
  // flex-column screen renders straight down the page) must read spacer,
  // then the Folder pick, then the composer, never the other way round.
  it('the picks dock above the composer, behind a spacer, not under the header', async () => {
    useChatStore.setState({ chats: { a: chat({ chatId: 'a', folder: '/p/one' }) } });
    const r = await renderReady();
    const everyHostNode = findAllHost(r.root, () => true);
    const indexOf = (testID: string): number =>
      everyHostNode.findIndex((i) => i.props['testID'] === testID);
    const spacerIdx = indexOf('new-chat-top-spacer');
    const folderPickIdx = indexOf('new-chat-folder-pill');
    const composerIdx = indexOf('composer-actions-row');
    expect(spacerIdx).toBeGreaterThanOrEqual(0);
    expect(folderPickIdx).toBeGreaterThan(spacerIdx);
    expect(composerIdx).toBeGreaterThan(folderPickIdx);
  });
});

describe('NewChat — folder picker sheet', () => {
  beforeEach(() => {
    saveLastNewChat({
      hostId: HOST,
      folder: '/home/tom/projects/one',
      model: null,
      permissionMode: null,
    });
    useChatStore.setState({
      chats: {
        a: chat({ chatId: 'a', folder: '/home/tom/projects/one', lastUpdated: 5 }),
        b: chat({ chatId: 'b', folder: '/p/two', lastUpdated: 3 }),
        j: chat({ chatId: 'j', folder: '/p/jobonly', lastUpdated: 9, jobId: 'nightly' }),
      },
    });
  });

  it('the pill opens a sheet listing recents, newest first, job folders excluded', async () => {
    const r = await renderReady();
    expect(findAllHost(r.root, byTestId('folder-sheet'))).toHaveLength(0);
    await openSheet(r);
    expect(sheetRows(r)).toEqual(['/home/tom/projects/one', '/p/two']);
    const row = findHost(r.root, byTestId('folder-sheet-row-/home/tom/projects/one'));
    expect(hasText(row, 'one')).toBe(true);
    expect(hasText(row, '~/projects/one')).toBe(true);
    expect(hasText(row, 'd1-box')).toBe(true);
  });

  it('no host chips with one host; the search filters by name or path', async () => {
    const r = await renderReady();
    await openSheet(r);
    expect(findAllHost(r.root, byTestId('folder-sheet-host-all'))).toHaveLength(0);
    searchSheet(r, 'two');
    expect(sheetRows(r)).toEqual(['/p/two']);
    searchSheet(r, 'projects');
    expect(sheetRows(r)).toEqual(['/home/tom/projects/one']);
    searchSheet(r, 'zzz');
    expect(hasText(findHost(r.root, byTestId('folder-sheet-empty')), 'No matching folders.')).toBe(
      true,
    );
  });

  it('tapping a row chooses the folder, closes the sheet and updates the pill', async () => {
    const r = await renderReady();
    await openSheet(r);
    await press(r, 'folder-sheet-row-/p/two');
    expect(findAllHost(r.root, byTestId('folder-sheet'))).toHaveLength(0);
    expect(pillText(r)).toBe('two · d1-box');
    typeText(r, 'go');
    await send(r);
    expect(api.createChat).toHaveBeenCalledWith({ hostId: HOST, folder: '/p/two' });
  });

  it('the backdrop dismisses without changing the choice', async () => {
    const r = await renderReady();
    await openSheet(r);
    await press(r, 'folder-sheet-backdrop');
    expect(findAllHost(r.root, byTestId('folder-sheet'))).toHaveLength(0);
    expect(pillText(r)).toBe('one · d1-box');
  });

  it('typing a path switches to path completion on the host; a suggestion completes it, "Use" chooses it', async () => {
    api.browseFolders
      .mockResolvedValueOnce({
        hostId: HOST,
        dir: '/home/tom',
        parent: null,
        entries: [
          { name: 'projects', path: '/home/tom/projects' },
          { name: 'photos', path: '/home/tom/photos' },
          { name: 'notes', path: '/home/tom/notes' },
        ],
      })
      .mockResolvedValue({ hostId: HOST, dir: '/home/tom/projects', parent: null, entries: [] });
    const r = await renderReady();
    await openSheet(r);
    searchSheet(r, '~/p');
    await actAsync(async () => {
      await flush();
    });
    expect(api.browseFolders).toHaveBeenCalledWith(HOST, '~');
    // Only entries starting with the typed partial are offered.
    const names = findAllHost(r.root, (i) =>
      String(i.props['testID'] ?? '').startsWith('folder-sheet-suggestion-'),
    ).map((i) => i.props.testID);
    expect(names).toEqual(['folder-sheet-suggestion-projects', 'folder-sheet-suggestion-photos']);
    // Recents are not listed while the text is a path.
    expect(sheetRows(r)).toEqual([]);
    await press(r, 'folder-sheet-suggestion-projects');
    expect(findHost(r.root, byTestId('folder-sheet-search')).props.value).toBe('~/projects/');
    await press(r, 'folder-sheet-use-typed');
    expect(pillText(r)).toBe('projects · d1-box');
  });

  it('a path-completion error is shown, never an empty list', async () => {
    api.browseFolders.mockRejectedValue(new Error('folder_not_found'));
    const r = await renderReady();
    await openSheet(r);
    searchSheet(r, '/nope/x');
    await actAsync(async () => {
      await flush();
    });
    expect(hasText(findHost(r.root, byTestId('folder-sheet-error')), 'folder_not_found')).toBe(
      true,
    );
  });

  it('Browse… opens the tree at the host roots, drills in, and "Use this folder" picks it', async () => {
    api.browseFolders
      .mockResolvedValueOnce({
        dir: null,
        parent: null,
        entries: [{ name: 'projects', path: '/p' }],
      })
      .mockResolvedValueOnce({ dir: '/p/deep', parent: '/p', entries: [] });
    const r = await renderReady();
    await openSheet(r);
    await press(r, 'folder-sheet-browse');
    expect(api.browseFolders).toHaveBeenCalledWith(HOST, undefined);
    // No breadcrumb at the roots view.
    expect(findAllHost(r.root, byTestId('folder-sheet-breadcrumb'))).toHaveLength(0);
    await press(r, 'folder-sheet-browse-entry-projects');
    expect(api.browseFolders).toHaveBeenLastCalledWith(HOST, '/p');
    expect(hasText(findHost(r.root, byTestId('folder-sheet-breadcrumb')), 'deep')).toBe(true);
    expect(hasText(r.root, 'No subfolders here.')).toBe(true);
    await press(r, 'folder-sheet-use-folder');
    expect(findAllHost(r.root, byTestId('folder-sheet'))).toHaveLength(0);
    expect(pillText(r)).toBe('deep · d1-box');
  });

  it('"Up a level" browses to the parent; back returns to the folder list', async () => {
    api.browseFolders.mockResolvedValue({ dir: '/p/a', parent: '/p', entries: [] });
    const r = await renderReady();
    await openSheet(r);
    await press(r, 'folder-sheet-browse');
    await press(r, 'folder-sheet-browse-up');
    expect(api.browseFolders).toHaveBeenLastCalledWith(HOST, '/p');
    await press(r, 'folder-sheet-browse-back');
    expect(findAllHost(r.root, byTestId('folder-sheet-browser'))).toHaveLength(0);
    expect(sheetRows(r)).toEqual(['/home/tom/projects/one', '/p/two']);
  });

  it('a browse error is shown in place of the tree (NO FALLBACK)', async () => {
    api.browseFolders.mockRejectedValue(new Error('folder_not_found'));
    const r = await renderReady();
    await openSheet(r);
    await press(r, 'folder-sheet-browse');
    expect(hasText(findHost(r.root, byTestId('folder-sheet-error')), 'folder_not_found')).toBe(
      true,
    );
  });

  it('with several hosts and none chosen there is nothing to browse, and it says so', async () => {
    __clearAllMmkv();
    usePresenceStore.setState({ hosts: { [HOST]: host(HOST), [OTHER]: host(OTHER) } });
    useChatStore.getState()._reset();
    const r = await renderReady();
    await openSheet(r);
    await press(r, 'folder-sheet-browse');
    expect(api.browseFolders).not.toHaveBeenCalled();
    expect(
      hasText(findHost(r.root, byTestId('folder-sheet-error')), 'Choose which machine to browse.'),
    ).toBe(true);
  });
});

describe('NewChat — folder picker sheet, several hosts', () => {
  beforeEach(() => {
    saveLastNewChat({ hostId: HOST, folder: '/p/one', model: null, permissionMode: null });
    usePresenceStore.setState({
      hosts: { [HOST]: host(HOST, true, { runsManager: true }), [OTHER]: host(OTHER, true) },
    });
    useChatStore.setState({
      chats: {
        a: chat({ chatId: 'a', folder: '/p/one', lastUpdated: 5 }),
        b: chat({ chatId: 'b', hostId: OTHER, folder: '/p/other', lastUpdated: 3 }),
      },
    });
  });

  it("lists every host's recents under All, with a host tag, and a chip per host narrows it", async () => {
    const r = await renderReady();
    await openSheet(r);
    expect(sheetRows(r)).toEqual(['/p/one', '/p/other']);
    expect(hasText(findHost(r.root, byTestId('folder-sheet-row-/p/other')), 'd2-box')).toBe(true);
    await press(r, `folder-sheet-host-${OTHER}`);
    expect(sheetRows(r)).toEqual(['/p/other']);
    await press(r, 'folder-sheet-host-all');
    expect(sheetRows(r)).toEqual(['/p/one', '/p/other']);
  });

  it('picking a folder picks its host, and drops the model and mode chosen on the old one', async () => {
    const r = await renderReady();
    await press(r, 'new-chat-model-quick-claude-sonnet-5');
    await openSheet(r);
    await press(r, 'folder-sheet-row-/p/other');
    expect(pillText(r)).toBe('other · d2-box');
    expect(selected(r, 'new-chat-model-quick-claude-sonnet-5')).toBe(false);
    typeText(r, 'go');
    await send(r);
    expect(api.createChat).toHaveBeenCalledWith({ hostId: OTHER, folder: '/p/other' });
  });

  it('a folder on an offline host is refused, loudly', async () => {
    usePresenceStore.setState({
      hosts: { [HOST]: host(HOST, true, { runsManager: true }), [OTHER]: host(OTHER, false) },
    });
    const r = await renderReady();
    await openSheet(r);
    await press(r, 'folder-sheet-row-/p/other');
    expect(pillText(r)).toBe('one · d1-box');
    expect(useUiStore.getState().errors[0]?.message).toContain('d2-box is offline');
  });

  it('with several hosts, none home, and no chats — no host is guessed', async () => {
    __clearAllMmkv();
    usePresenceStore.setState({ hosts: { [HOST]: host(HOST), [OTHER]: host(OTHER) } });
    useChatStore.getState()._reset();
    const r = await renderReady();
    expect(pillText(r)).toBe('Choose a folder…');
    typeText(r, 'hi');
    await send(r);
    expect(api.createChat).not.toHaveBeenCalled();
    expect(useUiStore.getState().errors[0]?.message).toBe(
      'Choose which machine to start the chat on.',
    );
  });
});

describe('NewChat — the first send creates the chat', () => {
  beforeEach(() => {
    saveLastNewChat({ hostId: HOST, folder: '/p/one', model: null, permissionMode: null });
    useChatStore.setState({ chats: { a: chat({ chatId: 'a', folder: '/p/one' }) } });
  });

  it('creates the chat with only what was chosen, sends into it, and opens it', async () => {
    const r = await renderReady();
    expect(api.createChat).not.toHaveBeenCalled();
    typeText(r, '  fix the build  ');
    await send(r);
    expect(api.createChat).toHaveBeenCalledWith({ hostId: HOST, folder: '/p/one' });
    expect(useChatStore.getState().chats['chat_new']).toBeDefined();
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy.mock.calls[0]?.[0]).toBe('chat_new');
    expect(submitSpy.mock.calls[0]?.[1]).toBe('fix the build');
    expect(useChatStore.getState().timelines['chat_new']?.[0]?.content).toBe('fix the build');
    expect(routerMock.replace).toHaveBeenCalledWith('/chats/chat_new?justCreated=1');
    expect(getComposerDraft(NEW_CHAT_DRAFT_KEY)).toBe('');
  });

  it('carries an explicitly chosen model and permission mode', async () => {
    const r = await renderReady();
    await press(r, 'new-chat-model-quick-claude-sonnet-5');
    expect(selected(r, 'new-chat-model-quick-claude-sonnet-5')).toBe(true);
    await press(r, 'new-chat-permission-mode');
    await press(r, 'permission-mode-option-plan');
    expect(hasText(findHost(r.root, byTestId('new-chat-permission-mode')), 'Plan only')).toBe(true);
    typeText(r, 'go');
    await send(r);
    expect(api.createChat).toHaveBeenCalledWith({
      hostId: HOST,
      folder: '/p/one',
      model: 'claude-sonnet-5',
      permissionMode: 'plan',
    });
  });

  it('the mode reads the host default until one is chosen', async () => {
    usePresenceStore.setState({
      hosts: { [HOST]: host(HOST, true, { permissionModeDefault: 'acceptEdits' }) },
    });
    const r = await renderReady();
    expect(
      hasText(findHost(r.root, byTestId('new-chat-permission-mode')), 'Auto-accept edits'),
    ).toBe(true);
  });

  it('sending with no folder chosen is refused, keeping the text', async () => {
    __clearAllMmkv();
    useChatStore.getState()._reset();
    const r = await renderReady();
    typeText(r, 'keep me');
    await send(r);
    expect(api.createChat).not.toHaveBeenCalled();
    expect(useUiStore.getState().errors[0]?.message).toBe('Choose a folder before sending.');
    expect(findHost(r.root, byType('TextInput')).props.value).toBe('keep me');
  });

  it('a refused create says why, retracts any ghost row, and keeps the draft', async () => {
    useChatStore.getState().ensureChat('chat_ghost', '/p/one');
    api.createChat.mockRejectedValue(
      new ApiErrorClass(400, 'folder_not_found', { retractChatId: 'chat_ghost' }),
    );
    const r = await renderReady();
    typeText(r, 'hello');
    await send(r);
    expect(useUiStore.getState().errors[0]?.message).toBe(
      'Failed to create chat: folder_not_found',
    );
    expect(useChatStore.getState().chats['chat_ghost']).toBeUndefined();
    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(getComposerDraft(NEW_CHAT_DRAFT_KEY)).toBe('hello');
  });

  it('a create that fails with a plain error still reports it', async () => {
    api.createChat.mockRejectedValue(new Error('network down'));
    const r = await renderReady();
    typeText(r, 'hello');
    await send(r);
    expect(useUiStore.getState().errors[0]?.message).toBe('Failed to create chat: network down');
  });

  it('a shared file waiting in the new-chat composer uploads into the NEW chat', async () => {
    useComposerAttachmentStore.getState().add(NEW_CHAT_DRAFT_KEY, [
      {
        key: 'k1',
        uri: 'file:///c/doc.pdf',
        name: 'doc.pdf',
        mimeType: 'application/pdf',
        kind: 'file',
      },
    ]);
    api.uploadAttachment.mockResolvedValue({
      ref: { id: 'att1', name: 'doc.pdf', mimeType: 'application/pdf', kind: 'file' },
    });
    const r = await renderReady();
    await send(r);
    expect(api.uploadAttachment).toHaveBeenCalledWith('chat_new', {
      uri: 'file:///c/doc.pdf',
      name: 'doc.pdf',
      mimeType: 'application/pdf',
    });
    expect(routerMock.replace).toHaveBeenCalledWith('/chats/chat_new?justCreated=1');
    expect(useComposerAttachmentStore.getState().byKey[NEW_CHAT_DRAFT_KEY]).toBeUndefined();
  });

  it('an attachment send navigates into the new chat at once, the message pending there while it uploads', async () => {
    useComposerAttachmentStore
      .getState()
      .add(NEW_CHAT_DRAFT_KEY, [
        { key: 'k1', uri: 'file:///c/a.txt', name: 'a.txt', mimeType: 'text/plain', kind: 'file' },
      ]);
    let resolveUpload!: (v: unknown) => void;
    api.uploadAttachment.mockReturnValue(new Promise((res) => (resolveUpload = res)));
    const r = await renderReady();
    typeText(r, 'with a file');
    await send(r);
    // The chat is created (that await is fine), then the send reacts at once:
    // navigated, composer cleared, message in the new chat marked uploading.
    expect(api.createChat).toHaveBeenCalledTimes(1);
    expect(routerMock.replace).toHaveBeenCalledWith('/chats/chat_new?justCreated=1');
    expect(useComposerAttachmentStore.getState().byKey[NEW_CHAT_DRAFT_KEY]).toBeUndefined();
    expect(getComposerDraft(NEW_CHAT_DRAFT_KEY)).toBe('');
    const entry = useChatStore.getState().timelines['chat_new']?.[0];
    expect(entry?.content).toBe('with a file');
    expect(entry?.upload).toEqual({ done: 0, total: 1, failed: false });
    expect(submitSpy).not.toHaveBeenCalled();

    await actAsync(async () => {
      resolveUpload({
        ref: { id: 'att1', name: 'a.txt', mimeType: 'text/plain', kind: 'file' },
      });
      await flush();
    });
    expect(submitSpy.mock.calls[0]?.[0]).toBe('chat_new');
    expect(submitSpy.mock.calls[0]?.[1]).toBe('with a file');
  });

  it('a failed upload after create stays in the new chat as Not uploaded; the chat is kept', async () => {
    useComposerAttachmentStore
      .getState()
      .add(NEW_CHAT_DRAFT_KEY, [
        { key: 'k1', uri: 'file:///c/a.txt', name: 'a.txt', mimeType: 'text/plain', kind: 'file' },
      ]);
    api.uploadAttachment.mockRejectedValue(new Error('413'));
    const r = await renderReady();
    await send(r);
    expect(routerMock.replace).toHaveBeenCalledWith('/chats/chat_new?justCreated=1');
    expect(useChatStore.getState().timelines['chat_new']?.[0]?.upload?.failed).toBe(true);
    expect(
      useUiStore.getState().errors.some((e) => e.message === 'attachment upload failed: 413'),
    ).toBe(true);
    await actAsync(async () => {
      r.unmount();
      await flush();
    });
    expect(api.deleteChat).not.toHaveBeenCalled();
    expect(useChatStore.getState().chats['chat_new']).toBeDefined();
  });

  it('leaving without sending creates nothing and deletes nothing', async () => {
    const r = await renderReady();
    typeText(r, 'not yet');
    await actAsync(async () => {
      findHost(r.root, byLabel('Cancel')).props.onPress();
      r.unmount();
      await flush();
    });
    expect(routerMock.back).toHaveBeenCalled();
    expect(api.createChat).not.toHaveBeenCalled();
    expect(api.deleteChat).not.toHaveBeenCalled();
    // The unsent text is kept for next time, as web keeps a new-chat draft.
    expect(getComposerDraft(NEW_CHAT_DRAFT_KEY)).toBe('not yet');
  });

  it('text shared into a new chat is waiting in the composer', async () => {
    setComposerDraft(NEW_CHAT_DRAFT_KEY, 'https://example.com');
    const r = await renderReady();
    expect(findHost(r.root, byType('TextInput')).props.value).toBe('https://example.com');
  });
});

// spec/15 § Navigation shell — the launcher's New chat shortcut opens this
// screen on a cold start as the only one in the stack, where `router.back()`
// does nothing. Its back arrow goes to the chat list instead.
describe('NewChat — back with nothing beneath it', () => {
  it('goes to the chat list', async () => {
    routerMock.canGoBack.mockReturnValueOnce(false);
    const r = await renderReady();
    await actAsync(async () => {
      findHost(r.root, byLabel('Cancel')).props.onPress();
      await flush();
    });
    expect(routerMock.back).not.toHaveBeenCalled();
    expect(routerMock.replace).toHaveBeenCalledWith('/(tabs)/chats');
  });
});

it('refreshes models when ChatGPT connects on the current host', async () => {
  const r = await renderReady();
  const calls = api.models.mock.calls.length;
  api.models.mockResolvedValue({ models: [{ id: 'openai/test', label: 'ChatGPT test' }] });
  await actAsync(async () => {
    usePresenceStore.getState().setHostAccount({
      type: 'host.account',
      hostId: HOST,
      backendId: 'codex',
      connected: true,
    });
    await flush();
  });
  expect(api.models.mock.calls.length).toBeGreaterThan(calls);
  expect(findHost(r.root, byTestId('new-chat-model-quick-openai/test'))).toBeTruthy();
});

describe('NewChat — account usage', () => {
  it('shows a usage line for each connected account with its 5-hour and weekly figures', async () => {
    useSettingsStore.setState({
      data: {
        preferences: {},
        shared: {
          version: 1,
          secrets: {
            claude: [
              { id: 'c0', label: 'Work', connected: true },
              { id: 'c1', label: 'Home', connected: true },
              { id: 'c2', label: 'Dead', connected: false },
            ],
            codex: [],
            providerKeys: [],
          },
          hosts: [],
        },
      } as never,
    });
    usePresenceStore.setState({
      hosts: {
        [HOST]: {
          ...host(HOST),
          accounts: {
            'claude-code': {
              accounts: [
                {
                  id: 'c0',
                  label: 'Work',
                  connected: true,
                  usage: {
                    session: { status: 'allowed', utilization: 0.42 },
                    week: { status: 'allowed', utilization: 0.1 },
                  },
                },
              ],
            },
          },
        } as never,
      },
    });
    const r = await renderReady();
    const work = textOf(findHost(r.root, byTestId('new-chat-usage-claude-code-c0')));
    expect(work).toContain('Work');
    expect(work).toContain('42%');
    expect(work).toContain('10%');
    expect(textOf(findHost(r.root, byTestId('new-chat-usage-claude-code-c1')))).toContain(
      'not read',
    );
    expect(findAllHost(r.root, byTestId('new-chat-usage-claude-code-c2'))).toHaveLength(0);
  });
});
