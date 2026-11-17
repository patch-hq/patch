// The Hidden and Archived headers' counts (spec/15 ## Chats tab §§5, 7, spec/04
// § Section counts). Mirrors the web's `useSectionCounts`: the phone's
// cold-start chat list excludes hidden and archived chats, so the store cannot
// measure either section — each number is the server's own total, refetched
// whenever a chat changes lifecycle state.
//
// NO FALLBACK: `null` (no badge) until the server has answered, and a failed or
// malformed answer raises a toast and leaves both null. A confident `0` on a
// section that is actually full is worse than no number at all.

import React from 'react';
import { api } from '../api/rest';
import { useChatStore } from '../stores/chatStore';
import { useUiStore } from '../stores/uiStore';
import { usePresenceStore } from '../stores/presenceStore';

export interface SectionCounts {
  archived: number | null;
  hidden: number | null;
}

const UNKNOWN: SectionCounts = { archived: null, hidden: null };

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function useSectionCounts(): SectionCounts {
  const [counts, setCounts] = React.useState<SectionCounts>(UNKNOWN);

  React.useEffect(() => {
    let live = true;
    // Answers can arrive out of order; only the latest ask may set the counts.
    let asked = 0;
    const load = (): void => {
      const mine = ++asked;
      api
        .chatSectionCounts()
        .then((r) => {
          if (!isCount(r.archived) || !isCount(r.hidden)) {
            throw new Error(`malformed section counts: ${JSON.stringify(r)}`);
          }
          if (live && mine === asked) setCounts({ archived: r.archived, hidden: r.hidden });
        })
        .catch((e: Error) => {
          // A failure while the link is down is the expected blip of a server
          // restart: the banner already says so, and the reconnect below asks
          // again. Only a failure on a link that claims to be up is an error.
          if (usePresenceStore.getState().connection !== 'connected') return;
          useUiStore.getState().pushError(`failed to load section counts: ${e.message}`);
        });
    };
    load();
    // Refetch only when a chat's lifecycle actually moved, not on every
    // streamed token — the same reference-check-then-signature filter as web.
    let lastChats = useChatStore.getState().chats;
    let lastSignature = lifecycleSignature(lastChats);
    const unsubscribe = useChatStore.subscribe((state) => {
      if (state.chats === lastChats) return;
      lastChats = state.chats;
      const next = lifecycleSignature(lastChats);
      if (next === lastSignature) return;
      lastSignature = next;
      load();
    });
    // Counts missed or failed while the socket was down are asked for again the
    // moment it is back; nothing else would, until a chat changed state.
    let lastConnection = usePresenceStore.getState().connection;
    const unsubscribePresence = usePresenceStore.subscribe((state) => {
      const was = lastConnection;
      lastConnection = state.connection;
      if (state.connection === 'connected' && was !== 'connected') load();
    });
    return () => {
      live = false;
      unsubscribe();
      unsubscribePresence();
    };
  }, []);

  return counts;
}

/** Which chats exist and each one's `status` and `hidden`, order-independent. */
function lifecycleSignature(chats: Record<string, { status: string; hidden: boolean }>): string {
  return Object.entries(chats)
    .map(([id, c]) => `${id}:${c.status}:${c.hidden ? 'h' : ''}`)
    .sort()
    .join('|');
}
