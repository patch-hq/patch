// Host files tab — climb out of the repo (spec/14 § File browser): open
// without a chat, the breadcrumb reaching `/` from a chat, Places, editing a
// file outside the chat folder with the host-files version guard, host-wide
// ⌘P reaching an absolute path, and ⌘⇧F search-in-files.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { JSX } from 'react';
import { HostFilesPage } from '../components/HostFilesPage.js';
import { FilesPage } from '../components/FilesPage.js';
import { useLayoutStore, resolvePane } from '../stores/layoutStore.js';
import type { PatchWs } from '../api/ws.js';
import { useUiStore, EMPTY_HOST_BROWSE_STATE } from '../stores/uiStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore, type HostPresence } from '../stores/presenceStore.js';
import { useHostSearchStore } from '../stores/hostSearchStore.js';
import { api, ApiError } from '../api/rest.js';

vi.mock('../lib/monaco-loader.js', () => ({
  ensureMonacoLoaded: async () => undefined,
}));

vi.mock('@monaco-editor/react', () => {
  const DiffEditor = (): JSX.Element => <div data-testid="mock-diff-editor" />;
  const Editor = ({
    value,
    onChange,
  }: {
    value?: string;
    onChange?: (v: string | undefined) => void;
  }): JSX.Element => (
    <textarea
      data-testid="mock-editor"
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  );
  return { DiffEditor, Editor };
});

function withQuery(node: JSX.Element): JSX.Element {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

function seedChat(chatId: string, folder: string, hostId = 'd1'): void {
  useChatStore.getState().hydrate([
    {
      chatId,
      hostId,
      permissionMode: 'bypassPermissions' as const,
      name: chatId,
      folder,
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    },
  ]);
}

function seedHost(
  hostId: string,
  opts: { hostName?: string; online?: boolean; roots?: string[] } = {},
): void {
  usePresenceStore.setState((s) => ({
    hosts: {
      ...s.hosts,
      [hostId]: {
        hostId,
        online: opts.online ?? true,
        lastSeenAt: Date.now(),
        host: { hostName: opts.hostName ?? hostId, platform: 'linux' } as HostPresence['host'],
        accounts: {},
        claudeSettings: null,
        folders: { roots: opts.roots ?? [], recent: [] },
      },
    },
  }));
}

beforeEach(() => {
  useChatStore.getState()._reset();
  usePresenceStore.setState({ hosts: {} });
  useHostSearchStore.getState().reset();
  useLayoutStore.getState()._reset();
  useUiStore.setState({
    hostBrowse: EMPTY_HOST_BROWSE_STATE,
    browseByChat: {},
    recentHostFiles: [],
    filePickerOpen: false,
    searchInFilesOpen: false,
    fileDiff: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('open without a chat (spec/14 § File browser)', () => {
  it('with exactly one host, browses straight to its home — no picker', async () => {
    seedHost('d1', { hostName: 'hetzner' });
    vi.spyOn(api, 'hostFilesList').mockResolvedValue({
      path: '/home/tom',
      parent: '/home',
      entries: [{ name: 'projects', type: 'dir' }],
    });
    render(withQuery(<HostFilesPage ws={null} />));
    expect(screen.queryByTestId('host-picker')).toBeNull();
    expect(await screen.findByTestId('host-browse-entry-projects')).toBeInTheDocument();
    expect(screen.getByTestId('browse-breadcrumb-current')).toHaveTextContent('tom');
  });

  it('with more than one host, shows a picker naming each, offline ones disabled', async () => {
    seedHost('d1', { hostName: 'mac' });
    seedHost('d2', { hostName: 'hetzner', online: false });
    render(withQuery(<HostFilesPage ws={null} />));
    expect(await screen.findByTestId('host-picker')).toBeInTheDocument();
    expect(screen.getByTestId('host-picker-d1')).not.toBeDisabled();
    expect(screen.getByTestId('host-picker-d2')).toBeDisabled();
  });
});

describe('breadcrumb reaches / from a chat (spec/14 § File browser — climb out of the repo)', () => {
  it('the chat folder breadcrumb runs all the way to /, and a crumb above it climbs out', async () => {
    seedChat('c1', '/home/tom/projects/widget');
    seedHost('d1');
    vi.spyOn(api, 'listFilesRecursive').mockResolvedValue({ entries: [] });
    vi.spyOn(api, 'hostFilesList').mockResolvedValue({
      path: '/home/tom/projects',
      parent: '/home/tom',
      entries: [
        { name: 'widget', type: 'dir' },
        { name: 'other-project', type: 'dir' },
      ],
    });
    render(withQuery(<FilesPage chatId="c1" />));
    // Every ancestor is reachable: /, home, tom, projects, widget (current).
    expect(await screen.findByTestId('browse-breadcrumb-crumb-/')).toBeInTheDocument();
    expect(screen.getByTestId('browse-breadcrumb-crumb-/home/tom/projects')).toBeInTheDocument();
    expect(screen.getByTestId('browse-breadcrumb-current')).toHaveTextContent('widget');

    fireEvent.click(screen.getByTestId('browse-breadcrumb-crumb-/home/tom/projects'));

    // One click above the chat folder opens the host files tab, rooted there.
    const layout = useLayoutStore.getState();
    const pane = resolvePane(layout.root, layout.activePaneId);
    expect(pane.tabs.map((t) => t.descriptor)).toContainEqual({ kind: 'page', page: 'host-files' });
    expect(useUiStore.getState().hostBrowse).toMatchObject({
      hostId: 'd1',
      path: '/home/tom/projects',
    });
    cleanup();
    render(withQuery(<HostFilesPage ws={null} />));
    expect(await screen.findByTestId('host-browse-panel')).toBeInTheDocument();
    expect(await screen.findByTestId('host-browse-entry-other-project')).toBeInTheDocument();
  });
});

describe('host offline (spec/12 § Host-offline UX)', () => {
  it('browsing an offline host shows a calm state and raises no error', async () => {
    seedHost('d1', { hostName: 'hetzner', online: false });
    useUiStore.setState({ errors: [] });
    vi.spyOn(api, 'hostFilesList').mockRejectedValue(
      new ApiError(503, 'host_offline', { error: 'host_offline', hostId: 'd1' }),
    );
    render(withQuery(<HostFilesPage ws={null} />));
    expect(await screen.findByTestId('host-browse-offline')).toHaveTextContent(
      'hetzner host is offline.',
    );
    expect(screen.queryByTestId('host-browse-error')).toBeNull();
    expect(useUiStore.getState().errors).toEqual([]);
  });
});

describe('places list (spec/14 § File browser)', () => {
  it('lists Home, project folders, Skills and Claude settings', async () => {
    seedHost('d1', { roots: ['/home/tom/projects/widget', '/home/tom/projects/other'] });
    vi.spyOn(api, 'hostFilesList').mockImplementation(async (hostId, path) => {
      if (path === undefined) return { path: '/home/tom', parent: '/home', entries: [] };
      return { path, parent: '/', entries: [] };
    });
    render(withQuery(<HostFilesPage ws={null} />));
    await screen.findByTestId('host-browse-panel');
    fireEvent.click(screen.getByTestId('browse-places-toggle'));
    expect(await screen.findByTestId('browse-place-Home')).toBeInTheDocument();
    expect(screen.getByTestId('browse-place-widget')).toBeInTheDocument();
    expect(screen.getByTestId('browse-place-other')).toBeInTheDocument();
    expect(screen.getByTestId('browse-place-Skills')).toBeInTheDocument();
    expect(screen.getByTestId('browse-place-Claude settings')).toBeInTheDocument();
  });
});

describe('edit a file outside the chat folder from a chat (spec/14 § File browser)', () => {
  it('opens ~/.claude/skills/<x>/SKILL.md from a chat in another folder and saves it', async () => {
    seedChat('c1', '/home/tom/projects/widget');
    seedHost('d1');
    vi.spyOn(api, 'listFilesRecursive').mockResolvedValue({ entries: [] });
    vi.spyOn(api, 'hostFilesList').mockImplementation(async (hostId, path) => {
      if (path === undefined) return { path: '/home/tom', parent: '/home', entries: [] };
      if (path === '/home/tom/.claude/skills')
        return { path, parent: '/home/tom/.claude', entries: [{ name: 'buy', type: 'dir' }] };
      if (path === '/home/tom/.claude/skills/buy')
        return {
          path,
          parent: '/home/tom/.claude/skills',
          entries: [{ name: 'SKILL.md', type: 'file' }],
        };
      return { path: path ?? '/', parent: '/', entries: [] };
    });
    vi.spyOn(api, 'hostFileRead').mockResolvedValue({
      path: '/home/tom/.claude/skills/buy/SKILL.md',
      content: '# Buy skill',
      size: 11,
      version: 'v1',
    });
    const write = vi.spyOn(api, 'hostFileWrite').mockResolvedValue({
      path: '/home/tom/.claude/skills/buy/SKILL.md',
      size: 20,
      version: 'v2',
    });

    render(withQuery(<FilesPage chatId="c1" />));
    fireEvent.click(await screen.findByTestId('browse-places-toggle'));
    fireEvent.click(await screen.findByTestId('browse-place-Skills'));
    cleanup();
    render(withQuery(<HostFilesPage ws={null} />));
    fireEvent.click(await screen.findByTestId('host-browse-entry-buy'));
    fireEvent.click(await screen.findByTestId('host-browse-entry-SKILL.md'));

    const editor = await screen.findByTestId('mock-editor');
    expect(editor).toHaveValue('# Buy skill');
    fireEvent.change(editor, { target: { value: '# Buy skill, updated' } });
    fireEvent.click(screen.getByTestId('host-browse-save'));

    await waitFor(() =>
      expect(write).toHaveBeenCalledWith('d1', {
        path: '/home/tom/.claude/skills/buy/SKILL.md',
        content: '# Buy skill, updated',
        baseVersion: 'v1',
      }),
    );
  });
});

describe('version-guarded save (spec/14 § File browser — save conflicts)', () => {
  it('a 409 conflict offers Reload, with no Overwrite', async () => {
    useUiStore.setState({
      hostBrowse: { ...EMPTY_HOST_BROWSE_STATE, hostId: 'd1' },
    });
    seedHost('d1');
    vi.spyOn(api, 'hostFilesList').mockResolvedValue({
      path: '/home/tom',
      parent: '/home',
      entries: [{ name: 'a.ts', type: 'file' }],
    });
    const read = vi
      .spyOn(api, 'hostFileRead')
      .mockResolvedValue({ path: '/home/tom/a.ts', content: 'old', size: 3, version: 'v1' });
    vi.spyOn(api, 'hostFileWrite').mockRejectedValue(
      new ApiError(409, 'conflict', { message: 'changed on disk' }),
    );

    render(withQuery(<HostFilesPage ws={null} />));
    fireEvent.click(await screen.findByTestId('host-browse-entry-a.ts'));
    const editor = await screen.findByTestId('mock-editor');
    fireEvent.change(editor, { target: { value: 'mine' } });
    fireEvent.click(screen.getByTestId('host-browse-save'));

    expect(await screen.findByTestId('save-conflict-modal')).toBeInTheDocument();
    expect(screen.queryByTestId('save-conflict-overwrite')).toBeNull();
    expect(screen.getByTestId('save-conflict-reload')).toBeInTheDocument();

    read.mockResolvedValue({
      path: '/home/tom/a.ts',
      content: 'from disk now',
      size: 13,
      version: 'v2',
    });
    fireEvent.click(screen.getByTestId('save-conflict-reload'));
    await waitFor(() => expect(screen.getByTestId('mock-editor')).toHaveValue('from disk now'));
  });
});

describe('⌘P reaches a path outside the repo (spec/14 § File browser)', () => {
  it('typing an absolute path navigates straight there', async () => {
    useUiStore.setState({
      hostBrowse: { ...EMPTY_HOST_BROWSE_STATE, hostId: 'd1' },
    });
    seedHost('d1');
    vi.spyOn(api, 'hostFilesList').mockImplementation(async (hostId, path) => {
      if (path === '/etc')
        return { path: '/etc', parent: '/', entries: [{ name: 'hosts', type: 'file' }] };
      if (path === '/') return { path: '/', parent: null, entries: [{ name: 'etc', type: 'dir' }] };
      if (path === undefined) return { path: '/home/tom', parent: '/home', entries: [] };
      return { path, parent: '/', entries: [] };
    });
    render(withQuery(<HostFilesPage ws={null} />));
    await screen.findByTestId('host-browse-panel');
    useUiStore.getState().setFilePickerOpen(true);
    const input = await screen.findByTestId('host-file-search-input');
    fireEvent.change(input, { target: { value: '/etc' } });
    fireEvent.click(await screen.findByTestId('host-file-search-path'));
    expect(await screen.findByTestId('host-browse-entry-hosts')).toBeInTheDocument();
  });

  it('the empty state lists recently opened host files', async () => {
    useUiStore.setState({
      hostBrowse: { ...EMPTY_HOST_BROWSE_STATE, hostId: 'd1' },
      recentHostFiles: [{ hostId: 'd1', path: '/a/b.ts', name: 'b.ts', touch: 1 }],
    });
    seedHost('d1');
    vi.spyOn(api, 'hostFilesList').mockResolvedValue({
      path: '/home/tom',
      parent: '/home',
      entries: [],
    });
    render(withQuery(<HostFilesPage ws={null} />));
    await screen.findByTestId('host-browse-panel');
    useUiStore.getState().setFilePickerOpen(true);
    expect(await screen.findByTestId('host-file-search-recent-/a/b.ts')).toBeInTheDocument();
  });
});

describe('⌘⇧F search in files (spec/14 § File browser, spec/03 § Host search)', () => {
  it('finds content and opens the hit at its line', async () => {
    useUiStore.setState({
      hostBrowse: { ...EMPTY_HOST_BROWSE_STATE, hostId: 'd1' },
    });
    seedHost('d1');
    vi.spyOn(api, 'hostFilesList').mockImplementation(async (hostId, path) => {
      if (path === '/home/tom/widget/src')
        return { path, parent: '/home/tom/widget', entries: [{ name: 'a.ts', type: 'file' }] };
      if (path === undefined) return { path: '/home/tom/widget', parent: '/home/tom', entries: [] };
      return { path: path ?? '/home/tom/widget', parent: '/home/tom', entries: [] };
    });
    vi.spyOn(api, 'hostFileRead').mockResolvedValue({
      path: '/home/tom/widget/src/a.ts',
      content: 'line one\nfindMe here\n',
      size: 20,
      version: 'v1',
    });
    const sent: unknown[] = [];
    render(
      withQuery(
        <HostFilesPage ws={{ send: (e: unknown) => sent.push(e) } as unknown as PatchWs} />,
      ),
    );
    await screen.findByTestId('host-browse-panel');
    useUiStore.getState().setHostBrowse({ hostId: 'd1', path: '/home/tom/widget/src' });
    fireEvent.click(await screen.findByTestId('host-browse-entry-a.ts'));
    await screen.findByTestId('mock-editor');

    fireEvent.click(screen.getByTestId('host-browse-search-toggle'));
    const input = await screen.findByTestId('host-search-input');
    fireEvent.change(input, { target: { value: 'findMe' } });
    fireEvent.click(screen.getByTestId('host-search-run'));

    expect(sent).toHaveLength(1);
    const req = sent[0] as {
      type: string;
      searchId: string;
      hostId: string;
      root: string;
      query: string;
    };
    expect(req).toMatchObject({
      type: 'patch.host_search.request',
      hostId: 'd1',
      root: '/home/tom/widget/src',
      query: 'findMe',
    });

    useHostSearchStore.getState().ingest({
      type: 'patch.host_search.result',
      searchId: req.searchId,
      matches: [{ path: 'a.ts', line: 2, column: 1, preview: 'findMe here' }],
    });
    useHostSearchStore
      .getState()
      .ingest({ type: 'patch.host_search.done', searchId: req.searchId, ok: true });

    const hit = await screen.findByTestId('host-search-match-a.ts:2');
    fireEvent.click(hit);
    expect(await screen.findByTestId('mock-editor')).toHaveValue('line one\nfindMe here\n');
  });
});
