// Linked chats on the phone (spec/04 § Provider switches, § Moving to another
// host). A provider switch, a move, or carrying on after a provider session is
// gone all start a new chat linked to this one. The server drafts it; this
// holds the draft locally and says where to open it, on the new-chat screen,
// where the user reads, edits and sends its first message.

import { api, ApiError, type LinkedChatDraft } from '../api/rest';
import { useNewChatDraftStore } from '../stores/newChatDraftStore';

export function linkedDraftRoute(draftId: string): string {
  return `/new-chat?draftId=${encodeURIComponent(draftId)}`;
}

/** Hold the server's draft before navigating, so the screen opens on it. */
export function adoptLinkedDraft(draft: LinkedChatDraft): string {
  useNewChatDraftStore.getState().applyDraftUpdated(draft);
  return linkedDraftRoute(draft.id);
}

/** The reason a refused request gives, as the user should read it. */
export function linkedChatError(err: unknown): string {
  const body = err instanceof ApiError ? (err.body as { message?: unknown } | null) : null;
  return typeof body?.message === 'string' ? body.message : (err as Error).message;
}

/** Draft a new chat continuing `chatId` — on `model` for a provider switch — and return its route. */
export async function draftLinkedChat(chatId: string, model?: string): Promise<string> {
  const { draft } = await api.continueChat(chatId, model !== undefined ? { model } : {});
  return adoptLinkedDraft(draft);
}
