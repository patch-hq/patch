// Document editor (spec/14 § Document editor — Working with the agent):
// "Select a passage → a small popover to ask about or act on just that
// passage; the request goes to the chat with the selection attached." Step 1
// attaches the selection by quoting it into the chat's own composer draft
// (spec/14 § Composer — server-owned, so it's there the moment the user
// switches back to the chat) rather than sending anything itself — the user
// still writes and sends their own question.
import { joinQuotes, splitQuotes } from './composerQuotes.js';
import { useComposerDraftStore } from '../stores/composerDraftStore.js';

/** Pure for testability — the DOM-touching part is just reading/writing the store.
 * The new quote joins the stack of quotes already at the head of the draft. */
export function withQuotedSelection(existingDraft: string, selectedText: string): string {
  const { quotes, body } = splitQuotes(existingDraft);
  return joinQuotes([...quotes, selectedText], body);
}

export function quoteSelectionIntoComposer(chatId: string, selectedText: string): void {
  const store = useComposerDraftStore.getState();
  const existing = store.drafts[chatId] ?? '';
  store.setDraft(chatId, withQuotedSelection(existing, selectedText));
}
