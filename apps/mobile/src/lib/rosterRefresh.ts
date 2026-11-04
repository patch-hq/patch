// Re-fetch the chat roster and fold it into the store. bootstrap() does this
// once at cold start; a surface that outlives a dropped socket (or a long
// stretch in the background) has missed every chat.state / chat.spawned /
// delete fanned out meanwhile, and replay only covers chats it holds a
// transcript for. NO FALLBACK: a failed refresh is shown, not swallowed.

import { api } from '../api/rest';
import { getWs } from '../api/ws';
import { useChatStore } from '../stores/chatStore';
import { useUiStore } from '../stores/uiStore';
import { toChatListRow } from './chatListRow';

export async function refreshRoster(): Promise<void> {
  try {
    const list = await api.listChats();
    useChatStore.getState().hydrate(list.chats.map(toChatListRow));
    // Offline reading: bring each chat's on-phone transcript level with this roster.
    getWs().syncTranscripts();
  } catch (e) {
    useUiStore.getState().pushError(`failed to refresh chats: ${(e as Error).message}`);
  }
}
