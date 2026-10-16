// Host label for a chat row whose title is shared with a chat on another host
// (spec/04 § Name). Everywhere else the row carries no host.

import { titlesOnSeveralHosts } from '@patch/wire';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import type { ChatRow } from '../stores/types.js';
import { deriveChatTitle } from './chatTitle.js';

// One scan per chats map, shared by every row: rows re-render on every store
// change, so scanning per row would be quadratic.
let cachedFor: Record<string, ChatRow> | null = null;
let cached: Set<string> = new Set();

function ambiguousTitles(chats: Record<string, ChatRow>): Set<string> {
  if (cachedFor !== chats) {
    cached = titlesOnSeveralHosts(
      Object.values(chats).map((c) => ({ hostId: c.hostId, title: deriveChatTitle(c.name) })),
    );
    cachedFor = chats;
  }
  return cached;
}

/** The row's host name when its title also names a chat on another host, else null. */
export function useAmbiguousHostLabel(row: ChatRow): string | null {
  const ambiguous = useChatStore((s) => ambiguousTitles(s.chats).has(deriveChatTitle(row.name)));
  const hostName = usePresenceStore((s) => s.hosts[row.hostId]?.host?.hostName ?? row.hostId);
  return ambiguous ? hostName.trim() : null;
}
