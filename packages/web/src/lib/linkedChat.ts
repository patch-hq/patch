// Linked chats on the web (spec/04 § Provider switches, § Moving to another
// host). A provider switch, a move, or carrying on after a provider session is
// gone all start a new chat linked to this one. The server drafts it; this
// puts the draft in front of the user on the new-chat screen, where they read,
// edit and send its first message.

import { api, ApiError, type LinkedChatDraft } from '../api/rest.js';
import { useDraftStore } from '../stores/draftStore.js';

/** Where a drafted linked chat opens. */
export function linkedDraftPath(draftId: string): string {
  return `/chats/new?draft=${encodeURIComponent(draftId)}`;
}

/**
 * Hold the server's draft locally before navigating, so the new-chat screen
 * opens on it rather than minting a blank draft while the broadcast is still
 * on its way.
 */
export function adoptLinkedDraft(draft: LinkedChatDraft): string {
  useDraftStore.getState().applyUpdated(draft, draft.updatedAt);
  return linkedDraftPath(draft.id);
}

/** The reason a refused request gives, as the user should read it. */
export function linkedChatError(err: unknown): string {
  const body = err instanceof ApiError ? (err.body as { message?: unknown } | null) : null;
  return typeof body?.message === 'string' ? body.message : (err as Error).message;
}

/**
 * Draft a new chat continuing `chatId` — on `model` for a provider switch, as
 * it is otherwise — and return where to open it.
 */
export async function draftLinkedChat(chatId: string, model?: string): Promise<string> {
  const { draft } = await api.continueChat(chatId, model !== undefined ? { model } : {});
  return adoptLinkedDraft(draft);
}
