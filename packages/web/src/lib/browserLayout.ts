// Where a chat's browser is shown in this window (spec/14 § Browser): the bar
// in the chat, the small floating preview, or the large view — a pane beside
// the chat on a wide window, the whole screen on a narrow one.

import { useBrowserHandoffStore } from '../stores/browserHandoffStore.js';
import { useLayoutStore, type PaneNode, type TabDescriptor } from '../stores/layoutStore.js';

/** The browser takes this much of the room it shares with the chat when it opens beside it. */
const BROWSER_SHARE = 0.6;

/** The split holding a leaf pane, and where in it the leaf sits. */
function parentOf(
  node: PaneNode,
  leafId: string,
): { id: string; index: number; sizes: number[] } | null {
  if (node.type !== 'split') return null;
  const index = node.children.findIndex((c) => c.pane.id === leafId);
  if (index >= 0) return { id: node.id, index, sizes: node.children.map((c) => c.size) };
  for (const c of node.children) {
    const found = parentOf(c.pane, leafId);
    if (found) return found;
  }
  return null;
}

/** Narrower than this, the large view takes the whole screen instead of a pane. */
export const BROWSER_PANE_MIN_WINDOW = 640;

export function browserTab(chatId: string): TabDescriptor {
  return { kind: 'browser', chatId };
}

export function wideWindow(): boolean {
  return window.innerWidth >= BROWSER_PANE_MIN_WINDOW;
}

/** Open the large view: a pane to the right of the chat, or the whole screen. */
export function openBrowserLarge(chatId: string): void {
  useBrowserHandoffStore.getState().setView(chatId, 'large');
  if (!wideWindow()) return;
  const store = useLayoutStore.getState();
  const tab = browserTab(chatId);
  if (store.findTab(tab)) {
    store.openTab(tab);
    return;
  }
  const chat = store.findTab({ kind: 'chat', chatId });
  if (!chat) {
    store.openTab(tab);
    return;
  }
  store.openTab(tab, { paneId: chat.pane.id, placement: 'split', edge: 'right' });
  // Wider than an even split: the page needs the room more than the chat does.
  const after = useLayoutStore.getState();
  const leaf = after.findTab(tab)?.pane.id;
  const parent = leaf ? parentOf(after.root, leaf) : null;
  if (parent && parent.index > 0) {
    const chatSize = parent.sizes[parent.index - 1]!;
    const shared = chatSize + parent.sizes[parent.index]!;
    after.resizeSplit(parent.id, parent.index - 1, shared * (1 - BROWSER_SHARE) - chatSize);
  }
}

/** Close the large view, leaving the preview (`mini`) or only the bar. */
export function closeBrowserLarge(chatId: string, next: 'mini' | undefined): void {
  const store = useLayoutStore.getState();
  const found = store.findTab(browserTab(chatId));
  if (found) store.closeTab(found.pane.id, found.tab.id);
  useBrowserHandoffStore.getState().setView(chatId, next);
}
