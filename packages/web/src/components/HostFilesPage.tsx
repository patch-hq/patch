// HostFilesPage — the `{kind:'page', page:'host-files'}` tab's content: a
// machine's filesystem by absolute path, with no chat in between (spec/14 §
// File browser — open anywhere, climb to `/`, Places, host-wide ⌘P, ⌘⇧F).
// Reached from a chat's tree by climbing above its folder, from the sidebar's
// Files button when no chat is focused, and by ⌘⇧' / ⌘⇧F. The open file, the
// folder and the draft live in `uiStore.hostBrowse`, so the tab survives being
// closed and reopened where it was left.

import { type JSX, Fragment, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Folder, Search } from 'lucide-react';
import {
  BrowseSkeleton,
  Editor,
  SaveConflictModal,
  baseName,
  breadcrumbSegments,
  dirName,
  editorOptionsFor,
  inferLanguage,
  useSaveHotkey,
} from './EditorRail.js';
import { CloseIcon } from './icons.js';
import { useUiStore, type RecentHostFile } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useHostSearchStore, newHostSearchId } from '../stores/hostSearchStore.js';
import { MONACO_THEME } from '../lib/monacoTheme.js';
import { shortcutTitle } from '../lib/shortcuts.js';
import { api, ApiError, type HostFileEntry } from '../api/rest.js';
import type { PatchWs } from '../api/ws.js';

/** The two frames a ⌘⇧F search sends; results come back through `hostSearchStore`. */
type HostSearchSend =
  | {
      type: 'patch.host_search.request';
      searchId: string;
      hostId: string;
      root: string;
      query: string;
      caseSensitive?: boolean;
    }
  | { type: 'patch.host_search.cancel'; searchId: string };

/**
 * Editor overhaul (climb out of the repo, spec/14 § File browser): the
 * breadcrumb shared by the chat-relative tree (`BrowsePanel`) and the
 * host-wide browser (`HostBrowsePanel`) — every ancestor of `path` from `/`
 * down, each a button except the last (the current directory, plain text).
 */
export function Breadcrumb({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (path: string) => void;
}): JSX.Element {
  const segs = breadcrumbSegments(path);
  return (
    <nav className="browse-breadcrumb" data-testid="browse-breadcrumb" aria-label="path">
      {segs.map((seg, i) => {
        const isLast = i === segs.length - 1;
        return (
          <Fragment key={seg.path}>
            {i > 0 ? (
              <span className="browse-breadcrumb-sep" aria-hidden>
                /
              </span>
            ) : null}
            {isLast ? (
              <span className="browse-breadcrumb-current" data-testid="browse-breadcrumb-current">
                {seg.label}
              </span>
            ) : (
              <button
                type="button"
                className="browse-breadcrumb-crumb"
                data-testid={`browse-breadcrumb-crumb-${seg.path}`}
                onClick={() => onNavigate(seg.path)}
              >
                {seg.label}
              </button>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}

/**
 * Editor overhaul (places, spec/14 § File browser): the top-of-tree shortcut
 * list — Home, the host's project folders, Skills, Claude settings. A small
 * anchored menu rather than a permanent panel: the tree/editor pane is
 * already tight at rail width, and these are jump-to targets reached
 * occasionally, not a list browsed continuously like the tree itself.
 */
export function PlacesMenu({
  hostId,
  chatFolder,
  onPick,
}: {
  hostId: string;
  /** The chat this rail belongs to, when there is one — adds "Project skills". */
  chatFolder: string | null;
  onPick: (path: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const roots = usePresenceStore((s) => s.hosts[hostId]?.folders?.roots) ?? [];
  // Shares the `['host-home', hostId]` query key with `HostBrowsePanel`'s own
  // home read — a cache hit there, not a second request, whenever both are
  // mounted (climbing out of a chat renders both at once).
  const { data: home } = useQuery({
    queryKey: ['host-home', hostId],
    queryFn: async () => api.hostFilesList(hostId),
  });
  const homePath = home?.path ?? null;
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  const places: Array<{ label: string; path: string }> = [];
  if (homePath) places.push({ label: 'Home', path: homePath });
  for (const r of roots) places.push({ label: baseName(r) || r, path: r });
  if (homePath) places.push({ label: 'Skills', path: `${homePath}/.claude/skills` });
  if (chatFolder) places.push({ label: 'Project skills', path: `${chatFolder}/.claude/skills` });
  if (homePath) places.push({ label: 'Claude settings', path: `${homePath}/.claude` });
  return (
    <div className="browse-places">
      <button
        type="button"
        className="browse-places-toggle"
        data-testid="browse-places-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Places
      </button>
      {open ? (
        <div className="browse-places-menu" data-testid="browse-places-menu" role="menu">
          {places.length === 0 ? (
            <div className="browse-places-empty" data-testid="browse-places-empty">
              Loading…
            </div>
          ) : (
            places.map((p) => (
              <button
                key={p.path}
                type="button"
                role="menuitem"
                className="browse-places-item"
                data-testid={`browse-place-${p.label}`}
                onClick={() => {
                  setOpen(false);
                  onPick(p.path);
                }}
              >
                {p.label}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Editor overhaul (host-wide ⌘P, spec/14 § File browser): quick-open for the
 * host browser. Fuzzy-matches a recursive index of the CURRENT directory
 * (bounded — it is wherever the user has actually browsed to, never the
 * whole host) plus the recent-files list; typing an absolute path jumps
 * straight there without waiting for the index at all, which is how ⌘P
 * "reaches any path on the host" per spec rather than only what has been
 * indexed.
 */
function HostFileSearch({
  hostId,
  root,
  recent,
  loading,
  entries,
  onPickIndexed,
  onPickPath,
  onClose,
}: {
  hostId: string;
  root: string;
  recent: RecentHostFile[];
  loading: boolean;
  entries: HostFileEntry[];
  onPickIndexed: (relPath: string) => void;
  onPickPath: (absPath: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [q, setQ] = useState('');
  const isPath = q.startsWith('/');
  const matches = useMemo(() => {
    if (isPath) return [];
    const lower = q.toLowerCase();
    const files = entries.filter((e) => e.type === 'file');
    const ranked: Array<{ name: string; basename: string; score: number }> = [];
    for (const f of files) {
      const basename = f.name.split('/').pop() ?? f.name;
      const idxBase = basename.toLowerCase().indexOf(lower);
      const idxPath = f.name.toLowerCase().indexOf(lower);
      if (idxBase < 0 && idxPath < 0) continue;
      ranked.push({ name: f.name, basename, score: idxBase >= 0 ? idxBase : 1000 + idxPath });
    }
    ranked.sort((a, b) => a.score - b.score);
    return ranked;
  }, [q, entries, isPath]);
  const recentForHost = recent.filter((f) => f.hostId === hostId);
  return (
    <div className="file-search-modal" data-testid="host-file-search">
      <input
        autoFocus
        data-testid="host-file-search-input"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key !== 'Enter') return;
          if (isPath && q.length > 1) onPickPath(q);
          else if (matches[0]) onPickIndexed(matches[0].name);
        }}
        placeholder="Find file, or type an absolute path…"
      />
      {isPath ? (
        <ul>
          <li>
            <button type="button" data-testid="host-file-search-path" onClick={() => onPickPath(q)}>
              <span className="fs-name">Go to path</span>
              <span className="fs-path">{q}</span>
            </button>
          </li>
        </ul>
      ) : q === '' ? (
        <>
          <div className="file-search-section" data-testid="host-file-search-recent-label">
            Recent
          </div>
          <ul>
            {recentForHost.length === 0 ? (
              <li className="file-search-empty" data-testid="host-file-search-no-recent">
                No recent files
              </li>
            ) : (
              recentForHost.map((f) => (
                <li key={`${f.hostId}:${f.path}`}>
                  <button
                    type="button"
                    data-testid={`host-file-search-recent-${f.path}`}
                    onClick={() => onPickPath(f.path)}
                  >
                    <span className="fs-name">{f.name}</span>
                    <span className="fs-path">{f.path}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </>
      ) : (
        <>
          {loading ? <BrowseSkeleton rows={5} testId="host-file-search-loading" /> : null}
          <ul>
            {matches.slice(0, 30).map((m) => (
              <li key={m.name}>
                <button
                  type="button"
                  onClick={() => onPickIndexed(m.name)}
                  data-testid={`host-file-search-${m.basename}`}
                >
                  <span className="fs-name">{m.basename}</span>
                  <span className="fs-path">{m.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="file-search-hint" data-testid="host-file-search-root">
        in {root}
      </div>
    </div>
  );
}

/**
 * Editor overhaul (⌘⇧F search in files, spec/14 § File browser, spec/03 §
 * Host search): results grouped by file, streamed in as `hostSearchStore`
 * ingests `patch.host_search.result` frames, click to open at the line.
 * Cancellable — closing the panel mid-search sends `patch.host_search.cancel`
 * so the host stops walking for nothing.
 */
function HostSearchPanel({
  hostId,
  root,
  onSend,
  onOpenAt,
  onClose,
}: {
  hostId: string;
  root: string;
  onSend: (event: HostSearchSend) => void;
  onOpenAt: (path: string, line: number) => void;
  onClose: () => void;
}): JSX.Element {
  const search = useHostSearchStore();
  const [q, setQ] = useState(search.query);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function run(): void {
    const query = q.trim();
    if (query === '') return;
    const searchId = newHostSearchId();
    useHostSearchStore.getState().start(searchId, hostId, root, query);
    onSend({ type: 'patch.host_search.request', searchId, hostId, root, query });
  }
  function cancel(): void {
    if (search.searchId && search.status === 'running') {
      onSend({ type: 'patch.host_search.cancel', searchId: search.searchId });
    }
    useHostSearchStore.getState().cancel();
  }

  const byFile = useMemo(() => {
    const groups = new Map<string, typeof search.matches>();
    for (const m of search.matches) {
      const g = groups.get(m.path);
      if (g) g.push(m);
      else groups.set(m.path, [m]);
    }
    return [...groups.entries()];
  }, [search.matches]);

  return (
    <div className="host-search-panel" data-testid="host-search-panel">
      <div className="host-search-bar">
        <Search size={14} aria-hidden />
        <input
          ref={inputRef}
          data-testid="host-search-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') run();
          }}
          placeholder={`Search in files under ${root}…`}
        />
        {search.status === 'running' ? (
          <button type="button" data-testid="host-search-cancel" onClick={cancel}>
            Cancel
          </button>
        ) : (
          <button type="button" data-testid="host-search-run" onClick={run}>
            Search
          </button>
        )}
        <button
          type="button"
          className="editor-icon-btn"
          aria-label="close search"
          data-testid="host-search-close"
          onClick={onClose}
        >
          <CloseIcon size={16} />
        </button>
      </div>
      {search.status === 'error' ? (
        <div className="host-search-error" data-testid="host-search-error" role="alert">
          {search.error}
        </div>
      ) : null}
      <div className="host-search-results" data-testid="host-search-results">
        {byFile.length === 0 && search.status === 'running' ? (
          <BrowseSkeleton rows={5} testId="host-search-loading" />
        ) : byFile.length === 0 && search.status === 'done' ? (
          <div className="host-search-empty" data-testid="host-search-no-matches">
            No matches
          </div>
        ) : (
          byFile.map(([path, matches]) => (
            <div key={path} className="host-search-file" data-testid={`host-search-file-${path}`}>
              <div className="host-search-file-path">{path}</div>
              {matches.map((m, i) => (
                <button
                  key={i}
                  type="button"
                  className="host-search-match"
                  data-testid={`host-search-match-${path}:${m.line}`}
                  onClick={() => onOpenAt(path, m.line)}
                >
                  <span className="host-search-line">{m.line}</span>
                  <span className="host-search-preview">{m.preview}</span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
      {search.truncated ? (
        <div className="host-search-truncated" data-testid="host-search-truncated">
          Showing the first {search.matches.length} matches — narrow the search to see more.
        </div>
      ) : null}
    </div>
  );
}

/**
 * Editor overhaul (open without a chat / climb out of the repo, spec/14 §
 * File browser): the host-wide browser — a breadcrumb reaching `/`, Places,
 * one directory at a time (not the chat tree's always-expanded hierarchy:
 * walking an arbitrary host directory recursively is unbounded in a way a
 * chat's own folder isn't), an editor pane, and the host-files version guard
 * on save. Used both standalone (no chat at all) and from a chat that has
 * climbed above its own folder.
 */
function HostBrowsePanel({
  visible,
  onError,
  onNotice,
  ws,
}: {
  visible: boolean;
  onError: (msg: string) => void;
  onNotice: (msg: string) => void;
  ws: PatchWs | null;
}): JSX.Element {
  const hostBrowse = useUiStore((s) => s.hostBrowse);
  const setHostBrowse = useUiStore((s) => s.setHostBrowse);
  const recentHostFiles = useUiStore((s) => s.recentHostFiles);
  const addRecentHostFile = useUiStore((s) => s.addRecentHostFile);
  const filePickerOpen = useUiStore((s) => s.filePickerOpen);
  const setFilePickerOpen = useUiStore((s) => s.setFilePickerOpen);
  const hosts = usePresenceStore((s) => s.hosts);
  const queryClient = useQueryClient();

  const hostId = hostBrowse.hostId;

  // Standalone, more-than-one host: nothing chosen yet shows the picker.
  // Exactly one host needs no choice (mirrors the New-chat setup row).
  useEffect(() => {
    if (hostBrowse.hostId !== null) return;
    const ids = Object.keys(hosts);
    if (ids.length === 1) setHostBrowse({ hostId: ids[0] });
  }, [hostBrowse.hostId, hosts, setHostBrowse]);

  // ⌘⇧F (spec/14 § File browser — search in files): a global flag, not local
  // state, so the shortcut (bound at the app's top level in AppShell) can open
  // this panel from outside — including handing off from the chat-relative
  // tree, which has no search UI of its own (see `onSearchInFiles`).
  const searchOpen = useUiStore((s) => s.searchInFilesOpen);
  const setSearchOpen = useUiStore((s) => s.setSearchInFilesOpen);
  useEffect(() => {
    if (!visible) return;
    function onKey(e: KeyboardEvent): void {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() === 'e') {
        e.preventDefault();
        setFilePickerOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, setFilePickerOpen]);

  const homeQuery = useQuery({
    queryKey: ['host-home', hostId],
    queryFn: async () => api.hostFilesList(hostId as string),
    enabled: visible && hostId !== null,
  });

  const path = hostBrowse.path;
  const listQuery = useQuery({
    queryKey: ['host-list', hostId, path],
    queryFn: async () => api.hostFilesList(hostId as string, path ?? undefined),
    enabled: visible && hostId !== null,
    placeholderData: keepPreviousData,
  });
  useEffect(() => {
    if (listQuery.error) onError((listQuery.error as Error).message);
  }, [listQuery.error, onError]);

  const resolvedPath = listQuery.data?.path ?? path ?? homeQuery.data?.path ?? null;

  const indexQuery = useQuery({
    queryKey: ['host-index', hostId, resolvedPath],
    queryFn: async () =>
      api.hostFilesList(hostId as string, resolvedPath as string, {
        recursive: true,
        maxEntries: 5000,
      }),
    enabled: visible && hostId !== null && resolvedPath !== null && filePickerOpen,
  });

  const contentQuery = useQuery({
    queryKey: ['host-file-content', hostId, hostBrowse.openFile?.path],
    queryFn: async () => api.hostFileRead(hostId as string, hostBrowse.openFile!.path),
    enabled: visible && hostId !== null && hostBrowse.openFile !== null,
  });
  useEffect(() => {
    if (contentQuery.error) onError((contentQuery.error as Error).message);
  }, [contentQuery.error, onError]);
  useEffect(() => {
    if (!contentQuery.data || !hostBrowse.openFile || hostBrowse.version !== null) return;
    setHostBrowse({ version: contentQuery.data.version });
  }, [contentQuery.data, hostBrowse.openFile, hostBrowse.version, setHostBrowse]);

  const [conflictOpen, setConflictOpen] = useState(false);

  function navigate(next: string): void {
    setHostBrowse({ path: next, openFile: null, draft: null, version: null });
  }

  function openFileAt(full: string): void {
    const name = baseName(full);
    setHostBrowse({ openFile: { name, path: full }, draft: null, version: null });
    if (hostId) addRecentHostFile({ hostId, path: full, name });
  }

  async function saveDraft(): Promise<void> {
    if (!hostId || !hostBrowse.openFile || hostBrowse.draft === null) return;
    if (hostBrowse.draft === (contentQuery.data?.content ?? '')) return;
    const target = hostBrowse.openFile;
    const draft = hostBrowse.draft;
    try {
      const res = await api.hostFileWrite(hostId, {
        path: target.path,
        content: draft,
        baseVersion: hostBrowse.version ?? '',
      });
      queryClient.setQueryData(['host-file-content', hostId, target.path], {
        path: target.path,
        content: draft,
        size: draft.length,
        version: res.version,
      });
      setHostBrowse({ version: res.version });
      onNotice(`Saved ${target.path}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConflictOpen(true);
        return;
      }
      onError((err as Error).message);
    }
  }
  function resolveConflictReload(): void {
    setConflictOpen(false);
    setHostBrowse({ draft: null, version: null });
    if (hostId && hostBrowse.openFile) {
      void queryClient.invalidateQueries({
        queryKey: ['host-file-content', hostId, hostBrowse.openFile.path],
      });
    }
  }

  const panelRef = useRef<HTMLDivElement>(null);
  useSaveHotkey(visible && hostBrowse.openFile !== null, () => void saveDraft(), panelRef);

  function openAtLine(relPath: string, line: number): void {
    if (!resolvedPath) return;
    const full = resolvedPath === '/' ? `/${relPath}` : `${resolvedPath}/${relPath}`;
    openFileAt(full);
    setSearchOpen(false);
    setGoToLine(line);
  }
  // Monaco's OWN `editor.action.gotoLine` already binds ⌃G (spec/14 §
  // Keyboard shortcuts), so this is just how a search hit tells the editor
  // which line to land on once it has mounted for the newly-opened file.
  const [goToLine, setGoToLine] = useState<number | null>(null);

  if (hostId === null) {
    const ids = Object.keys(hosts);
    return (
      <div className="editor-empty" data-testid="host-picker">
        <p>Choose a host</p>
        {ids.length === 0 ? (
          <p data-testid="host-picker-empty">No hosts registered.</p>
        ) : (
          ids.map((id) => {
            const h = hosts[id];
            const online = h?.online ?? false;
            return (
              <button
                key={id}
                type="button"
                data-testid={`host-picker-${id}`}
                disabled={!online}
                onClick={() => setHostBrowse({ hostId: id, path: null, openFile: null })}
              >
                {h?.host?.hostName ?? id}
                {online ? '' : ' · offline'}
              </button>
            );
          })
        )}
      </div>
    );
  }

  const entries: HostFileEntry[] = listQuery.data?.entries ?? [];

  return (
    <div className="browse-panel" data-testid="host-browse-panel" ref={panelRef}>
      <div className="browse-tree" data-testid="host-browse-tree">
        <div className="browse-tree-header">
          <PlacesMenu hostId={hostId} chatFolder={null} onPick={navigate} />
        </div>
        {resolvedPath ? <Breadcrumb path={resolvedPath} onNavigate={navigate} /> : null}
        <div className="browse-tree-list" data-testid="host-browse-list">
          {listQuery.isPending ? (
            <BrowseSkeleton rows={6} testId="host-browse-loading" />
          ) : listQuery.isError ? (
            <div className="browse-tree-error" data-testid="host-browse-error" role="alert">
              {(listQuery.error as Error).message}
            </div>
          ) : entries.length === 0 ? (
            <div className="browse-tree-empty" data-testid="host-browse-empty">
              Empty folder
            </div>
          ) : (
            entries.map((e) => {
              const full = resolvedPath === '/' ? `/${e.name}` : `${resolvedPath}/${e.name}`;
              return (
                <button
                  key={e.name}
                  type="button"
                  className="browse-row"
                  data-testid={`host-browse-entry-${e.name}`}
                  disabled={e.type === 'other'}
                  onClick={() => (e.type === 'dir' ? navigate(full) : openFileAt(full))}
                >
                  {e.type === 'dir' ? (
                    <Folder size={14} aria-hidden />
                  ) : (
                    <FileText size={14} aria-hidden />
                  )}
                  <span>{e.name}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
      <div className="browse-editor" data-testid="host-browse-editor">
        {hostBrowse.openFile ? (
          <>
            <div className="browse-meta-strip">
              <span className="browse-meta-name">{hostBrowse.openFile.name}</span>
              <button
                type="button"
                className="editor-icon-btn"
                aria-label="search in files"
                title={shortcutTitle('Search in files', '⌘⇧F')}
                data-testid="host-browse-search-toggle"
                onClick={() => setSearchOpen(!searchOpen)}
              >
                <Search size={16} aria-hidden />
              </button>
              <button
                type="button"
                className="save-btn"
                data-testid="host-browse-save"
                disabled={
                  hostBrowse.draft === null ||
                  hostBrowse.draft === (contentQuery.data?.content ?? '')
                }
                onClick={() => void saveDraft()}
              >
                Save
              </button>
            </div>
            {contentQuery.isPending ? (
              <div className="editor-loading" data-testid="host-browse-content-loading">
                Loading…
              </div>
            ) : contentQuery.isError ? (
              <div
                className="browse-tree-error"
                data-testid="host-browse-content-error"
                role="alert"
              >
                {hostBrowse.openFile.path}: {(contentQuery.error as Error).message}
              </div>
            ) : (
              <HostFileEditor
                path={hostBrowse.openFile.path}
                value={hostBrowse.draft ?? contentQuery.data?.content ?? ''}
                goToLine={goToLine}
                onChange={(next) => setHostBrowse({ draft: next })}
              />
            )}
          </>
        ) : (
          <div className="editor-empty" data-testid="host-browse-no-file">
            Select a file to view it
          </div>
        )}
      </div>
      {searchOpen && resolvedPath ? (
        <HostSearchPanel
          hostId={hostId}
          root={resolvedPath}
          onSend={(ev) => ws?.send(ev)}
          onOpenAt={openAtLine}
          onClose={() => setSearchOpen(false)}
        />
      ) : null}
      {filePickerOpen ? (
        <HostFileSearch
          hostId={hostId}
          root={resolvedPath ?? ''}
          recent={recentHostFiles}
          loading={indexQuery.isPending}
          entries={indexQuery.data?.entries ?? []}
          onPickIndexed={(rel) => {
            if (!resolvedPath) return;
            const full = resolvedPath === '/' ? `/${rel}` : `${resolvedPath}/${rel}`;
            openFileAt(full);
            setFilePickerOpen(false);
          }}
          onPickPath={(abs) => {
            setFilePickerOpen(false);
            if (abs.endsWith('/')) {
              navigate(abs.slice(0, -1) || '/');
              return;
            }
            // A typed path could be a file or a directory — ask the host which,
            // via a plain (non-recursive) list of its PARENT, rather than
            // guessing from the string alone.
            const parent = dirName(abs) || '/';
            void api
              .hostFilesList(hostId as string, parent)
              .then((res) => {
                const name = baseName(abs);
                const hit = res.entries.find((e) => e.name === name);
                if (hit?.type === 'dir') navigate(abs);
                else openFileAt(abs);
              })
              .catch((err: unknown) => onError((err as Error).message));
          }}
          onClose={() => setFilePickerOpen(false)}
        />
      ) : null}
      {conflictOpen && hostBrowse.openFile ? (
        <SaveConflictModal
          path={hostBrowse.openFile.path}
          onReload={resolveConflictReload}
          onCancel={() => setConflictOpen(false)}
        />
      ) : null}
    </div>
  );
}

/** The host browser's editor pane — same Monaco setup as `WholeFileEditor`, plus go-to-line on open. */
function HostFileEditor({
  path,
  value,
  goToLine,
  onChange,
}: {
  path: string;
  value: string;
  goToLine: number | null;
  onChange: (next: string) => void;
}): JSX.Element {
  const language = inferLanguage(path);
  return (
    <Editor
      value={value}
      language={language}
      theme={MONACO_THEME}
      options={{
        minimap: { enabled: false },
        automaticLayout: true,
        scrollBeyondLastColumn: 0,
        ...editorOptionsFor(language),
      }}
      onChange={(next) => onChange(next ?? '')}
      onMount={(editor) => {
        (window as unknown as { __monacoMounted?: boolean }).__monacoMounted = true;
        if (goToLine !== null) {
          (editor as unknown as { revealLineInCenter: (l: number) => void }).revealLineInCenter(
            goToLine,
          );
          (
            editor as unknown as {
              setPosition: (p: { lineNumber: number; column: number }) => void;
            }
          ).setPosition({ lineNumber: goToLine, column: 1 });
        }
      }}
      loading={<div data-testid="diff-loading">Loading…</div>}
    />
  );
}

export function HostFilesPage({ ws }: { ws: PatchWs | null }): JSX.Element {
  const pushError = useUiStore((s) => s.pushError);
  const pushNotice = useUiStore((s) => s.pushNotice);
  return (
    <Suspense fallback={<div className="editor-loading">Loading editor…</div>}>
      <HostBrowsePanel
        visible
        onError={(msg) => pushError(`files: ${msg}`)}
        onNotice={(msg) => pushNotice(msg)}
        ws={ws}
      />
    </Suspense>
  );
}
