// The read watermark of each chat on this phone: the highest seq seen on its
// last visit (spec/14 § Status badges — the `read` / `done` split). MMKV, like the roster cache beside it.
//
// Without it a relaunch forgets every visit: the roster arrives with each
// chat's `lastUpdated`, nothing says it was seen, and every chat reads "New
// reply" until it is opened again. Unlike the roster this is the only copy of
// the fact — the server does not know what this phone has looked at — so it is
// kept for as long as the chat exists and dropped with it.

import { store, VISITED_KEY } from './credential';
import { useUiStore } from '../stores/uiStore';

/** chatId -> highest seq seen on the last visit. Unreadable content is reported and dropped, never thrown on the launch path. */
export function loadVisited(): Record<string, number> {
  const raw = store().getString(VISITED_KEY);
  if (raw === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('visited chats is not an object');
    }
    const out: Record<string, number> = {};
    for (const [id, at] of Object.entries(parsed)) {
      if (typeof at === 'number' && Number.isFinite(at)) out[id] = at;
    }
    return out;
  } catch (e) {
    store().delete(VISITED_KEY);
    useUiStore.getState().pushError(`visited chats unreadable: ${(e as Error).message}`);
    return {};
  }
}

export function saveVisited(visited: Record<string, number>): void {
  store().set(VISITED_KEY, JSON.stringify(visited));
}
