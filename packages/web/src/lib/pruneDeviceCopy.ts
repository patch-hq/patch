// Prune the device copy to the chat list (spec/05 § Loading, Device copy).
//
// Run once the sidebar has loaded its chats from the server — the active list
// and the snoozed chats folded into it. A cached transcript of any chat not
// among them (deleted, archived or hidden elsewhere) is dropped, so it does not
// stay in the browser until it ages out of the most-recently-opened bound.
// Chats this window has open are kept whatever the list says.

import { useChatStore } from '../stores/chatStore.js';
import { pruneTranscripts } from './transcriptCache.js';

export async function pruneDeviceCopy(): Promise<void> {
  const { chats, timelines, activeChatId } = useChatStore.getState();
  const keep = new Set([...Object.keys(chats), ...Object.keys(timelines)]);
  if (activeChatId !== null) keep.add(activeChatId);
  await pruneTranscripts(keep);
}
