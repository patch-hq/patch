// openViewBesideChat — open a view in the pane directly to the right of its
// owning chat (spec/14 § Views), so the user marks items with the conversation
// that will act on them in view. A view already open is only focused.

import { useLayoutStore, type TabDescriptor } from '../stores/layoutStore.js';

export function openViewBesideChat(viewId: string, chatId: string): void {
  const store = useLayoutStore.getState();
  const viewTab: TabDescriptor = { kind: 'page', page: 'view', viewId };
  if (store.findTab(viewTab)) {
    store.openTab(viewTab);
    return;
  }
  const chatTab: TabDescriptor = { kind: 'chat', chatId };
  let chat = store.findTab(chatTab);
  if (!chat) {
    store.showChat(chatId);
    chat = useLayoutStore.getState().findTab(chatTab);
  }
  if (chat) {
    useLayoutStore
      .getState()
      .openTab(viewTab, { paneId: chat.pane.id, placement: 'split', edge: 'right' });
  } else {
    useLayoutStore.getState().openTab(viewTab);
  }
}
