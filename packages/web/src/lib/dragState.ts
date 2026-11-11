// dragState — which kind of drag is in flight, so the group row can draw its
// drop targets (the gaps between groups, "Show here" over a group) only while
// something that can land there is being dragged (spec/14 § Panes and tabs,
// § Groups). A native drag exposes its payload types only to the elements it
// passes over, so this reads them once at `dragstart` and clears on drop/end.

import { useSyncExternalStore } from 'react';

/** The custom MIME type a tab drag carries — `{ paneId, tabId }` JSON. Not
 *  `text/plain`: that would let a tab title be "dropped" as text anywhere
 *  else the browser accepts a text drop (a composer, an address bar). */
export const TAB_DRAG_TYPE = 'application/x-patch-tab';
/** The custom MIME type a sidebar chat-row drag carries — the chat id. */
export const CHAT_DRAG_TYPE = 'application/x-patch-chat';

export type DragKind = 'tab' | 'chat';

let kind: DragKind | null = null;
const listeners = new Set<() => void>();

function set(next: DragKind | null): void {
  if (kind === next) return;
  kind = next;
  for (const l of listeners) l();
}

let installed = false;
function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  // Bubble phase on window: the source's own `dragstart` handler (which sets
  // the payload) has already run by the time it reaches here.
  window.addEventListener('dragstart', (e) => {
    const types = e.dataTransfer?.types ?? [];
    if (types.includes(TAB_DRAG_TYPE)) set('tab');
    else if (types.includes(CHAT_DRAG_TYPE)) set('chat');
  });
  const clear = (): void => {
    tabSource = null;
    set(null);
  };
  window.addEventListener('dragend', clear, true);
  window.addEventListener('drop', clear);
}

function subscribe(l: () => void): () => void {
  install();
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Where the tab being dragged came from — a native drag hides its payload
 *  until the drop, but whether a group may accept the tab (it must show the
 *  same chat) has to be known while hovering. Null when no tab drag began here. */
let tabSource: { groupId: string; chatId: string | null } | null = null;

export function beginTabDrag(groupId: string, chatId: string | null): void {
  tabSource = { groupId, chatId };
}

/** May the tab being dragged land in group `groupId` showing `chatId`? A group
 *  shows one chat and a tab belongs to it (spec/14 § Panes and tabs), so only
 *  the tab's own group, or another group showing the same chat, accepts it. */
export function acceptsTabDrop(groupId: string, chatId: string | null): boolean {
  if (tabSource === null) return true; // the store validates the move itself
  return (
    tabSource.groupId === groupId || (tabSource.chatId !== null && tabSource.chatId === chatId)
  );
}

/** The kind of drag in flight, or null. */
export function useDragKind(): DragKind | null {
  return useSyncExternalStore(
    subscribe,
    () => kind,
    () => null,
  );
}

/** Test-only: force the state (jsdom has no native drags). */
export function _setDragKind(next: DragKind | null): void {
  set(next);
}
