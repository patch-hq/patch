// Document editor (spec/14 § Document editor — Working with the agent):
// "Select a passage → a small popover to ask about or act on just that
// passage; the request goes to the chat with the selection attached." Step 1
// attaches the selection by quoting it into the chat's own composer draft
// (spec/14 § Composer — server-owned, so it's there the moment the user
// switches back to the chat) rather than sending anything itself — the user
// still writes and sends their own question.
import { joinThread, splitThread } from './composerQuotes.js';
import { useComposerDraftStore } from '../stores/composerDraftStore.js';

/** Pure for testability — the DOM-touching part is just reading/writing the store.
 * With no quote in the draft yet, the new one goes ahead of whatever was typed
 * (that text is the question about it). Once there is one, the typed text is
 * the reply to it, so the new quote goes after it and gets a reply of its own. */
export function withQuotedSelection(existingDraft: string, selectedText: string): string {
  const { thread, body } = splitThread(existingDraft);
  const quote = { kind: 'quote' as const, text: selectedText };
  if (thread.length === 0) return joinThread([quote], body);
  const reply = body.trimEnd();
  return joinThread(
    reply === '' ? [...thread, quote] : [...thread, { kind: 'reply', text: reply }, quote],
    '',
  );
}

export function quoteSelectionIntoComposer(chatId: string, selectedText: string): void {
  const store = useComposerDraftStore.getState();
  const existing = store.drafts[chatId] ?? '';
  store.setDraft(chatId, withQuotedSelection(existing, selectedText));
}
