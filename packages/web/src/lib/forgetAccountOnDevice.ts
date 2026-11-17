// Everything this device holds of the signed-in account, dropped together:
// a shared or handed-on browser must not keep the account's chats
// (spec/05 § Loading, Device copy). Awaited by every sign-out path, so the
// deletes finish before the page reloads.

import { clearCredential } from './credential.js';
import { clearChatList } from './chatListCache.js';
import { clearTranscripts } from './transcriptCache.js';

const FEED_POS_KEY = 'patch.feedPos';

export async function forgetAccountOnDevice(): Promise<void> {
  clearCredential();
  try {
    window.localStorage.removeItem(FEED_POS_KEY);
  } catch {
    // Storage refused: nothing was kept there to forget.
  }
  await Promise.all([clearChatList(), clearTranscripts()]);
}
