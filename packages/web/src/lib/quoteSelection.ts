// Document editor (spec/14 § Document editor — Working with the agent):
// "Select a passage → a small popover to ask about or act on just that
// passage; the request goes to the chat with the selection attached." Step 1
// attaches the selection by quoting it into the chat's own composer draft
// (spec/14 § Composer — server-owned, so it's there the moment the user
// switches back to the chat) rather than sending anything itself — the user
// still writes and sends their own question.
import { joinThread, splitThread, type ThreadItem } from './composerQuotes.js';
import { useComposerDraftStore } from '../stores/composerDraftStore.js';

/** Pure for testability — the DOM-touching part is just reading/writing the store.
 * The quote lands at `caret`, an offset into the composer's input (the reply to
 * the last quote): what was typed before it becomes the reply above the new
 * quote, what follows stays in the input under it. Without a caret, a draft with
 * no quote yet gets the quote ahead of what was typed (that text is the question
 * about it), and a draft with quotes gets it after them. */
export function withQuotedSelection(
  existingDraft: string,
  selectedText: string,
  caret?: number,
): string {
  const { thread, body } = splitThread(existingDraft);
  const quote = { kind: 'quote' as const, text: selectedText };
  const at = Math.min(Math.max(caret ?? (thread.length === 0 ? 0 : body.length), 0), body.length);
  const before = body.slice(0, at);
  const after = body.slice(at);
  const next: ThreadItem[] = [...thread];
  if (before.trim() !== '') next.push({ kind: 'reply', text: before.trimEnd() });
  next.push(quote);
  return joinThread(next, after.replace(/^\n+/, ''));
}

export function quoteSelectionIntoComposer(
  chatId: string,
  selectedText: string,
  caret?: number,
): void {
  const store = useComposerDraftStore.getState();
  const existing = store.drafts[chatId] ?? '';
  store.setDraft(chatId, withQuotedSelection(existing, selectedText, caret));
}
