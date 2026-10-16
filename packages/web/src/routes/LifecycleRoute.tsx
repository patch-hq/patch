// LifecycleRoute — /lifecycle/:kind, the main-window view of one of the
// sidebar's cold-storage sections (Hidden / Archived / Snoozed / Deleted /
// Automations). App Updates: "can also open in main window" — the sidebar's
// own icon row (components/Sidebar.tsx § LifecyclePanel) opens the section
// inline for a quick check; this route is the same section's list, reached
// from that panel's "Open in main window" link, with the main panel's room
// rather than the sidebar's capped, scrolling band (spec/14 § Sidebar →
// Scroll regions caps an expanded lifecycle list at `min(33%, 300px)`).
//
// Reuses the exact section components the sidebar renders inline — same
// fetch-on-mount, same rows, same actions (Show / Unsnooze / Restore) — so
// there is one implementation of "what an Archived row looks like", not two.

import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { ChatSearchResults } from '../components/ChatSearch.js';
import { searchableQuery } from '../lib/chatSearch.js';
import { NavHistoryControls } from '../components/NavHistoryControls.js';
import { groupChats } from '../lib/chatGroups.js';
import { isNearScrollBottom } from '../lib/scrollPaging.js';
import {
  HiddenSection,
  ArchivedSection,
  SnoozedSection,
  DeletedSection,
  AutomationsSection,
} from '../components/Sidebar.js';

const LABELS = {
  hidden: 'Hidden',
  archived: 'Archived',
  snoozed: 'Snoozed',
  deleted: 'Deleted',
  automations: 'Automations',
} as const;

type Kind = keyof typeof LABELS;

// Sections the chat search can place a hit in; Deleted and Automations are not
// among them, so those pages carry no search field.
const SEARCHABLE = ['hidden', 'archived', 'snoozed'] as const;

function isKind(v: string | undefined): v is Kind {
  return v !== undefined && v in LABELS;
}

export function LifecycleRoute(): JSX.Element {
  const { kind } = useParams<{ kind: string }>();
  const chats = useChatStore((s) => s.chats);
  const folderRoster = useChatStore((s) => s.folderRoster);
  const activeChatId = useChatStore((s) => s.activeChatId);
  const sectionCount = useChatStore((s) =>
    s.sectionCounts && isKind(kind) ? s.sectionCounts[kind] : null,
  );
  const bumpLifecycleScrollTick = useUiStore((s) => s.bumpLifecycleScrollTick);
  const [query, setQuery] = useState('');
  const grouped = useMemo(
    () => groupChats(Object.values(chats), folderRoster),
    [chats, folderRoster],
  );

  if (!isKind(kind)) {
    return (
      <div className="route-error" data-testid="lifecycle-route-error">
        Unknown section: {kind}
      </div>
    );
  }

  const searchSection = (SEARCHABLE as readonly string[]).includes(kind)
    ? (kind as (typeof SEARCHABLE)[number])
    : null;
  const searched = searchSection === null ? null : searchableQuery(query);

  return (
    <main
      className="lifecycle-route"
      data-testid="lifecycle-route"
      onScroll={(e) => {
        if (isNearScrollBottom(e.currentTarget)) bumpLifecycleScrollTick();
      }}
    >
      <header className="route-head">
        <div className="route-head-title">
          <NavHistoryControls />
          <h1 className="display">{LABELS[kind]}</h1>
        </div>
        {searchSection !== null && (
          <input
            type="search"
            className="jobs-search"
            data-testid="lifecycle-search"
            data-search-input
            placeholder={`Search ${LABELS[kind].toLowerCase()} chats`}
            aria-label={`Search ${LABELS[kind].toLowerCase()} chats`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
      </header>
      {searched !== null && searchSection !== null ? (
        <div className="lifecycle-route-body" data-testid="lifecycle-search-results">
          <ChatSearchResults query={searched} activeChatId={activeChatId} section={searchSection} />
        </div>
      ) : (
        <div className="lifecycle-route-body" data-testid={`lifecycle-route-${kind}`}>
          {sectionCount === 0 && (
            <div className="empty-hint" data-testid="lifecycle-route-empty">
              No {LABELS[kind].toLowerCase()} chats
            </div>
          )}
          {kind === 'hidden' && (
            <HiddenSection hidden={grouped.hidden} activeChatId={activeChatId} />
          )}
          {kind === 'archived' && (
            <ArchivedSection archived={grouped.archived} activeChatId={activeChatId} />
          )}
          {kind === 'snoozed' && (
            <SnoozedSection snoozed={grouped.snoozed} activeChatId={activeChatId} />
          )}
          {kind === 'deleted' && (
            <DeletedSection deleted={grouped.deleted} activeChatId={activeChatId} />
          )}
          {kind === 'automations' && (
            <AutomationsSection automations={grouped.automations} activeChatId={activeChatId} />
          )}
        </div>
      )}
    </main>
  );
}
