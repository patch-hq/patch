// Which chats are valid "send this share to an existing chat" destinations,
// and in what order — the existing-chat half of the share flow (app/share.tsx)
// — and how a share is put into the chosen composer. Kept pure(ish) so the
// exclusion/ordering rule is unit-tested without rendering anything, same
// convention as chatFilter.ts.

import { isReadOnlyMirrorThread } from '@patch/wire';
import type { ChatRow } from '../stores/types';
import type { SharedPayload } from './shareIntent';
import { getComposerDraft, hasDraftText, setComposerDraft } from './composerDraft';
import { newAttachmentKey, useComposerAttachmentStore } from '../stores/composerAttachmentStore';
import { useNewChatDraftStore } from '../stores/newChatDraftStore';

/** Archived/deleted chats and read-only mirror threads (no composer, the host
 *  refuses input to them) aren't valid share destinations; the rest, most
 *  recently updated first — matching the Chats tab's own recency order. */
export function shareableChats(chats: Record<string, ChatRow>): ChatRow[] {
  return Object.values(chats)
    .filter(
      (c) => c.status !== 'archived' && c.status !== 'deleted' && !isReadOnlyMirrorThread(c.chatId),
    )
    .sort((a, b) => b.lastUpdated - a.lastUpdated);
}

/**
 * Put a share into the composer behind `draftKey` — a chat's, or the new-chat
 * screen's (a new-chat draft's own id). Nothing is sent: the text joins whatever is
 * already typed there (never overwriting it), and each file becomes an
 * ordinary attachment chip, uploaded by the composer's own path on Send
 * (spec/15 § Share into Patch).
 */
export function handShareToComposer(draftKey: string, share: SharedPayload): void {
  if (share.text !== null) {
    const current = getComposerDraft(draftKey);
    setComposerDraft(
      draftKey,
      hasDraftText(current) ? `${current.trimEnd()}\n\n${share.text}` : share.text,
    );
  }
  useComposerAttachmentStore.getState().add(
    draftKey,
    share.files.map((f) => ({
      key: newAttachmentKey(),
      uri: f.uri,
      name: f.name,
      mimeType: f.mimeType,
      kind: f.kind,
    })),
  );
}

/**
 * Same as `handShareToComposer`, but for the new-chat screen's draft (spec/14
 * § New chat drafts): the destination is a not-yet-spawned new chat, so its
 * text lives in the server-synced new-chat-draft store, keyed by the draft's
 * own id, not a chat's composer draft.
 */
export function handShareToNewChatDraft(draftId: string, share: SharedPayload): void {
  if (share.text !== null) {
    const store = useNewChatDraftStore.getState();
    const current = store.get(draftId)?.text ?? '';
    store.update(draftId, {
      text: hasDraftText(current) ? `${current.trimEnd()}\n\n${share.text}` : share.text,
    });
  }
  useComposerAttachmentStore.getState().add(
    draftId,
    share.files.map((f) => ({
      key: newAttachmentKey(),
      uri: f.uri,
      name: f.name,
      mimeType: f.mimeType,
      kind: f.kind,
    })),
  );
}
