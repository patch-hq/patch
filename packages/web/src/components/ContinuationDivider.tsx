// Where a thread of linked chats hands on (spec/04 § Provider switches,
// § Moving to another host; spec/05 § Capabilities and provider switches).
//
// A provider switch or a move starts a new chat linked to the old one. The two
// read as one continuing thread: the newer chat opens with a divider naming
// the chat it continues and what changed (the providers' models, or the hosts),
// and the older one ends with a divider naming the chat that continues it. Each
// divider links to the other chat.

import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { compactModelLabel } from '@patch/wire';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import type { ChatRow } from '../stores/types.js';

/** What changed between two linked chats, e.g. `Opus 5.5 → GPT-5.5` or `laptop → server`. */
export function continuationChange(
  earlier: Pick<ChatRow, 'model' | 'hostId'> | undefined,
  later: Pick<ChatRow, 'model' | 'hostId'> | undefined,
  hostName: (hostId: string) => string,
): string | null {
  if (!earlier || !later) return null;
  if (earlier.hostId !== later.hostId) {
    return `${hostName(earlier.hostId)} → ${hostName(later.hostId)}`;
  }
  if (earlier.model && later.model && earlier.model !== later.model) {
    return `${compactModelLabel(earlier.model)} → ${compactModelLabel(later.model)}`;
  }
  return null;
}

export function ContinuationDivider({
  row,
  edge,
}: {
  row: ChatRow;
  /** `start`: this chat continues another. `end`: another chat continues this one. */
  edge: 'start' | 'end';
}): JSX.Element | null {
  const otherId = edge === 'start' ? row.continuedFrom : row.continuedIn;
  const other = useChatStore((s) => (otherId !== undefined ? s.chats[otherId] : undefined));
  const hosts = usePresenceStore((s) => s.hosts);
  if (otherId === undefined) return null;
  const hostName = (hostId: string): string => hosts[hostId]?.host?.hostName ?? hostId;
  const change =
    edge === 'start'
      ? continuationChange(other, row, hostName)
      : continuationChange(row, other, hostName);
  const title = other?.name ?? 'New chat';
  return (
    <div className="mode-change" data-testid={`continuation-${edge}`}>
      <span className="mode-change-label">
        {edge === 'start' ? 'Continued from ' : 'Continued in '}
        <Link
          to={`/chats/${encodeURIComponent(otherId)}`}
          data-testid={`continuation-${edge}-link`}
        >
          {title}
        </Link>
        {change !== null ? ` · ${change}` : ''}
      </span>
    </div>
  );
}
