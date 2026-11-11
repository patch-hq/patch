// Global chat search in the sidebar (spec/03 § Chat search, spec/14 § Sidebar).
//
// One field in the sidebar's fixed top band searches every chat on every host —
// names and everything that was said — through `GET /api/chats/search`. While
// the trimmed query is long enough to send, the scrolling band shows the results
// in place of the chat list. The request is debounced, and only the latest
// query's answer may render: an earlier one landing late is dropped. Until the
// server answers, the chats this surface already holds are filtered locally so
// the band is never blank; the server's answer then replaces that wholesale.
// A host that could not be searched is always named under the results.

import type { JSX } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { OpenableLink } from './OpenableLink.js';
import {
  compareChatSearchHits,
  type ChatSearchHit,
  type ChatSearchHostResult,
  type ChatSearchResponse,
} from '@patch/wire';
import { api } from '../api/rest.js';
import type { ChatRow } from '../stores/chatStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import {
  highlightSegments,
  hostMarkerText,
  localSearchHits,
  searchHitPath,
  sectionLabel,
} from '../lib/chatSearch.js';
import { relativeTime } from '../lib/relativeTime.js';

/** How long typing has to pause before the query is sent. */
export const SEARCH_DEBOUNCE_MS = 250;
/** Results per page. */
const PAGE = 20;

/**
 * The sidebar's search field. The query lives in `uiStore.searchQuery` —
 * pressing a result clears it (`SearchHitRow`'s `onClick`), so opening a chat
 * from search always lands back on the ordinary list rather than leaving the
 * sidebar stuck on a stale query. Carries `data-search-input`, so ⌘K lands
 * here (lib/searchTarget.ts); and `data-search-global`, so ⌘F does not — over
 * a transcript that chord is the browser's find bar (spec/14 § Reserved OS
 * chords).
 */
export function ChatSearchField(): JSX.Element {
  const query = useUiStore((s) => s.searchQuery);
  const view = useUiStore((s) =>
    s.hiddenOpen
      ? 'hidden'
      : s.archivedOpen
        ? 'archived'
        : s.snoozedOpen
          ? 'snoozed'
          : s.automationsOpen
            ? 'automations'
            : null,
  );
  const setQuery = useUiStore((s) => s.setSearchQuery);
  return (
    <div className="chat-search-wrap">
      <input
        type="search"
        className="chat-search"
        data-testid="chat-search"
        data-search-input
        data-search-global
        placeholder={view === null ? 'Search chats…' : `Search ${view}`}
        aria-label={view === null ? 'Search chats' : `Search ${view}`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && query !== '') {
            e.preventDefault();
            e.stopPropagation();
            setQuery('');
          }
        }}
      />
      <button
        type="button"
        className="chat-search-clear"
        data-testid="chat-search-clear"
        aria-label="Clear search"
        onClick={() => setQuery('')}
      >
        ×
      </button>
    </div>
  );
}

/** One machine's part of a search: still out, answered, or failed. */
type HostRun =
  | { state: 'searching' }
  | {
      state: 'done';
      hits: ChatSearchHit[];
      statuses: ChatSearchHostResult[];
      nextOffset: number | null;
    }
  | { state: 'failed'; message: string };

/** A search is one request per machine, so each reports on its own. */
interface Run {
  key: string;
  /** hostId → progress; `''` is the single unscoped request used before any host is known. */
  hosts: Record<string, HostRun>;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Append a page, dropping any chat already listed (a chat whose rank moved). */
function appendHits(prev: ChatSearchHit[], next: ChatSearchHit[]): ChatSearchHit[] {
  const seen = new Set(prev.map((h) => h.chatId));
  return [...prev, ...next.filter((h) => !seen.has(h.chatId))];
}

/**
 * The results band. `query` is already trimmed and at least
 * `CHAT_SEARCH_MIN_QUERY` long — the caller decides when search is on.
 *
 * Search always covers everything — every machine, every section, archived and
 * hidden included. It is narrowed only by a bottom view being open (`section`,
 * or `automations`). Each machine is asked separately so its own progress
 * shows, and "no results" is said only once every machine has answered.
 */
export function ChatSearchResults({
  query,
  activeChatId,
  section,
  automations,
  renderRow,
}: {
  query: string;
  /**
   * Draws a hit as the list's own chat row (same buttons and menu) when the
   * chat is one this surface holds. A hit it holds no row for is drawn as a
   * plain result row.
   */
  renderRow?: (row: ChatRow, hit: ChatSearchHit) => JSX.Element;
  activeChatId: string | null;
  /** Keep only hits living in this chat-list section (a bottom view is open). */
  section?: ChatSearchHit['section'];
  /** Keep only chats a job spawned (the Automations view is open). */
  automations?: boolean;
}): JSX.Element {
  const fullText = useUiStore((s) => s.searchFullText);
  const setFullText = useUiStore((s) => s.setSearchFullText);
  const presence = usePresenceStore((s) => s.hosts);
  const hostIdsKey = Object.keys(presence).sort().join(',');
  const targets = useMemo(() => (hostIdsKey === '' ? [''] : hostIdsKey.split(',')), [hostIdsKey]);
  const key = `${query}\u0000${fullText}\u0000${hostIdsKey}`;
  const [run, setRun] = useState<Run | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Bumped for every query; a response only lands if it still matches.
  const genRef = useRef(0);

  const ask = (
    hostId: string,
    opts: { offset?: number; signal?: AbortSignal },
  ): Promise<ChatSearchResponse> =>
    api.searchChats(query, {
      limit: PAGE,
      fullText,
      includeArchived: true,
      includeHidden: true,
      ...(hostId !== '' ? { hostId } : {}),
      ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });

  useEffect(() => {
    const gen = ++genRef.current;
    setLoadingMore(false);
    setRun({
      key,
      hosts: Object.fromEntries(targets.map((t) => [t, { state: 'searching' } as HostRun])),
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      for (const t of targets) {
        ask(t, { signal: ctrl.signal }).then(
          (r) => {
            if (genRef.current !== gen) return;
            setRun((prev) =>
              prev === null || prev.key !== key
                ? prev
                : {
                    ...prev,
                    hosts: {
                      ...prev.hosts,
                      [t]: {
                        state: 'done',
                        hits: r.hits,
                        statuses: r.hosts,
                        nextOffset: r.nextOffset,
                      },
                    },
                  },
            );
          },
          (e: unknown) => {
            if (genRef.current !== gen) return;
            setRun((prev) =>
              prev === null || prev.key !== key
                ? prev
                : {
                    ...prev,
                    hosts: { ...prev.hosts, [t]: { state: 'failed', message: messageOf(e) } },
                  },
            );
          },
        );
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // `ask` is rebuilt every render; the key already captures what it reads.
  }, [key]);

  // A run belongs to one query AND one scope; anything else is not shown.
  const current = run !== null && run.key === key ? run : null;
  const entries = current === null ? [] : Object.entries(current.hosts);
  const searching = current === null || entries.some(([, h]) => h.state === 'searching');

  function loadMore(): void {
    if (current === null) return;
    const gen = genRef.current;
    const more = entries.flatMap(([t, h]) =>
      h.state === 'done' && h.nextOffset !== null ? [[t, h.nextOffset] as const] : [],
    );
    if (more.length === 0) return;
    setLoadingMore(true);
    let left = more.length;
    for (const [t, offset] of more) {
      ask(t, { offset }).then(
        (r) => {
          if (genRef.current !== gen) return;
          setRun((prev) => {
            const cur = prev?.hosts[t];
            return prev === null || prev.key !== key || cur?.state !== 'done'
              ? prev
              : {
                  ...prev,
                  hosts: {
                    ...prev.hosts,
                    [t]: {
                      state: 'done',
                      hits: appendHits(cur.hits, r.hits),
                      statuses: r.hosts,
                      nextOffset: r.nextOffset,
                    },
                  },
                };
          });
          if (--left === 0) setLoadingMore(false);
        },
        (e: unknown) => {
          if (genRef.current !== gen) return;
          setRun((prev) =>
            prev === null || prev.key !== key
              ? prev
              : {
                  ...prev,
                  hosts: { ...prev.hosts, [t]: { state: 'failed', message: messageOf(e) } },
                },
          );
          if (--left === 0) setLoadingMore(false);
        },
      );
    }
  }

  const chats = useChatStore((s) => s.chats);
  const inScope = (h: ChatSearchHit): boolean =>
    h.section !== 'manager' &&
    (section === undefined || h.section === section) &&
    (automations !== true || h.jobId !== null);

  const answered = useMemo(
    () =>
      entries
        .flatMap(([, h]) => (h.state === 'done' ? h.hits : []))
        .filter(inScope)
        .filter((h, i, all) => all.findIndex((o) => o.chatId === h.chatId) === i)
        .sort(compareChatSearchHits),
    [current, section, automations],
  );
  // Until a machine answers, the chats this surface already holds for it stand
  // in, so the band is never blank — dropped as soon as the real answer lands.
  const local = useMemo(() => {
    if (!searching) return [];
    const pending = new Set(entries.flatMap(([t, h]) => (h.state === 'searching' ? [t] : [])));
    const unscoped = pending.has('');
    const have = new Set(answered.map((h) => h.chatId));
    return localSearchHits(Object.values(chats), query, fullText).filter(
      (h) => (unscoped || pending.has(h.hostId)) && !have.has(h.chatId) && inScope(h),
    );
  }, [searching, current, chats, query, fullText, answered, section, automations]);

  // A host is named by what the surface already calls it (its self-reported
  // hostName, the same label the chat header and banners use), then by the
  // name the server returned, then by its id.
  const serverNames = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const [, h] of entries) {
      if (h.state === 'done') for (const st of h.statuses) m.set(st.hostId, st.hostName);
    }
    return m;
  }, [current]);
  const hostName = (hostId: string): string =>
    presence[hostId]?.host?.hostName ?? serverNames.get(hostId) ?? hostId;

  const drawHit = (hit: ChatSearchHit, testId: string): JSX.Element => {
    const row = chats[hit.chatId];
    return row !== undefined && renderRow !== undefined ? (
      <div
        key={hit.chatId}
        data-testid={testId}
        data-chat-id={hit.chatId}
        className="search-hit-wrap"
      >
        {renderRow(row, hit)}
      </div>
    ) : (
      <SearchHitRow
        key={hit.chatId}
        hit={hit}
        hostName={hostName(hit.hostId)}
        active={activeChatId}
        testId={testId}
      />
    );
  };

  const failures = entries.flatMap(([t, h]) =>
    h.state === 'failed' ? [{ host: t, message: h.message }] : [],
  );
  const errorRows = failures.map((f) => (
    <div key={f.host} className="empty-hint" data-testid="chat-search-error">
      Search failed{f.host !== '' ? ` on ${hostName(f.host)}` : ''}: {f.message}
    </div>
  ));
  const named = targets.length > 0 && targets[0] !== '';
  const moreAvailable = entries.some(([, h]) => h.state === 'done' && h.nextOffset !== null);

  return (
    <section className="sb-search-results" data-testid="chat-search-results">
      <div className="sb-search-mode" role="group" aria-label="Search in">
        <button
          type="button"
          className={`sb-search-mode-opt${fullText ? '' : ' on'}`}
          data-testid="chat-search-titles"
          aria-pressed={!fullText}
          onClick={() => setFullText(false)}
        >
          Titles
        </button>
        <button
          type="button"
          className={`sb-search-mode-opt${fullText ? ' on' : ''}`}
          data-testid="chat-search-fulltext"
          aria-pressed={fullText}
          onClick={() => setFullText(true)}
        >
          Full text
        </button>
      </div>
      {named ? (
        <div className="sb-search-hosts" data-testid="chat-search-hosts">
          {targets.map((t) => {
            const h = current?.hosts[t];
            const state = h === undefined ? 'searching' : h.state;
            return (
              <span
                key={t}
                className="sb-search-host-chip"
                data-testid={`chat-search-progress-${t}`}
                data-state={state}
              >
                <span className={`sb-search-dot ${state}`} aria-hidden />
                {hostName(t)}
              </span>
            );
          })}
        </div>
      ) : searching ? (
        <div className="sb-search-status" data-testid="chat-search-searching">
          Searching…
        </div>
      ) : null}
      {answered.map((hit) => drawHit(hit, 'chat-search-hit'))}
      {local.map((hit) => drawHit(hit, 'chat-search-local-hit'))}
      {!searching && answered.length === 0 && failures.length < entries.length ? (
        <div className="empty-hint" data-testid="chat-search-empty">
          No chats match “{query}”.
        </div>
      ) : null}
      {moreAvailable ? (
        <button
          type="button"
          className="sb-search-more"
          data-testid="chat-search-more"
          disabled={loadingMore}
          onClick={loadMore}
        >
          More results
        </button>
      ) : null}
      {errorRows}
      {entries.flatMap(([, h]) =>
        h.state === 'done'
          ? h.statuses.map((st) => {
              const text = hostMarkerText(st, hostName(st.hostId));
              return text === null ? null : (
                <div
                  key={st.hostId}
                  className="empty-hint sb-search-host"
                  data-testid={`chat-search-host-${st.hostId}`}
                  data-state={st.state}
                >
                  {text}
                </div>
              );
            })
          : [],
      )}
    </section>
  );
}

function Marked({
  text,
  ranges,
}: {
  text: string;
  ranges: readonly (readonly [number, number])[];
}): JSX.Element {
  return (
    <>
      {highlightSegments(text, ranges).map((seg, i) =>
        seg.marked ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>,
      )}
    </>
  );
}

/** The matched snippet, drawn as a chat row's secondary line. Nothing for a name-only hit. */
export function SearchMatchLine({ hit }: { hit: ChatSearchHit }): JSX.Element | null {
  if (hit.snippet === null) return null;
  return (
    <span className="search-snippet" data-testid="chat-search-snippet">
      {hit.snippet.role === 'user' ? <span className="search-role">You: </span> : null}
      <Marked text={hit.snippet.text} ranges={hit.snippet.highlights} />
    </span>
  );
}

function SearchHitRow({
  hit,
  hostName,
  active,
  testId,
}: {
  hit: ChatSearchHit;
  hostName: string;
  active: string | null;
  testId: string;
}): JSX.Element {
  const title = hit.name ?? hit.preview ?? 'New chat';
  const when = hit.snippet?.createdAt ?? hit.lastUpdated;
  const meta = [
    hostName,
    sectionLabel(hit),
    hit.jobId !== null ? 'Automation' : null,
    relativeTime(when, { futureLabel: 'just now' }),
  ]
    .filter((p): p is string => p !== null && p !== '')
    .join(' · ');
  return (
    <OpenableLink
      to={searchHitPath(hit)}
      opens={{ kind: 'chat', chatId: hit.chatId }}
      className={`sb-row search-hit${active === hit.chatId ? ' active' : ''}`}
      data-testid={testId}
      data-chat-id={hit.chatId}
      title={title}
      // Pressing a result opens the chat AND clears the search — leaving the
      // sidebar stuck on a stale query and results band after you've already
      // gone where you were looking for is the bug this fixes.
      onClick={() => useUiStore.getState().setSearchQuery('')}
    >
      <span className="name">
        {hit.name !== null ? <Marked text={hit.name} ranges={hit.nameHighlights} /> : title}
      </span>
      {hit.snippet !== null ? (
        <span className="search-snippet" data-testid="chat-search-snippet">
          {hit.snippet.role === 'user' ? <span className="search-role">You: </span> : null}
          <Marked text={hit.snippet.text} ranges={hit.snippet.highlights} />
        </span>
      ) : null}
      <span className="search-meta">
        {meta}
        {hit.messageMatches > 1 ? (
          <span className="search-more-count"> · +{hit.messageMatches - 1} more</span>
        ) : null}
      </span>
    </OpenableLink>
  );
}
