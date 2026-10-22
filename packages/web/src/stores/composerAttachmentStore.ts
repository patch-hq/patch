// Draft attachments (step 3 of 3 — spec/14 § Composer → Attachments): a file
// attached to an unsent draft uploads STRAIGHT AWAY and is registered on the
// server-held draft, so every open surface shows the same chip. Keyed by a
// "draft key" — an existing chat's chatId, or a new-chat draft's own id — the
// same key both `composer_draft.*` and `new_chat_draft.*` already use.
//
// SERVER-OWNED, same reasoning as composerDraftStore.ts / draftStore.ts: the
// server is the source of truth for what a draft's attachments currently are.
// This store holds the LOCAL projection of that — one entry per attachment,
// each independently uploading/uploaded/failed — reconciled against the
// server's `composer_draft.attachments_changed` / `new_chat_draft.
// attachments_changed` broadcasts (and the `.list` snapshot after auth.ok).
//
// An entry an OTHER surface added arrives with no local `File` to preview —
// it renders from its `url` instead (an ordinary `<img src>` / link). An
// entry THIS surface just attached renders from its local `previewUrl` while
// uploading, and keeps it after (revoking on remove) rather than switching to
// the server URL — no visible flash once the chip settles.
//
// NO FALLBACK: a failed upload keeps the chip, marked `failed`, with the file
// held for Retry (existing pattern — spec/14 § Composer → Attachments). An
// attachment is never silently dropped.

import { create } from 'zustand';
import type { AttachmentKind, DraftAttachmentRef } from '@patch/wire';
import { api } from '../api/rest.js';
import { useUiStore } from './uiStore.js';
import { downscaleImageFile } from '../lib/imageResize.js';

/** Where a draft key's attachments upload to/serve from — the two draft
 *  kinds have different routes (spec/14 & spec/15 § Composer → Attachments):
 *  an existing chat's composer already has a chatId; a new-chat draft
 *  doesn't, until it's promoted on first send. */
export type AttachmentTarget =
  | { kind: 'chat'; chatId: string }
  | { kind: 'new-chat-draft'; draftId: string };

export interface DraftAttachment {
  /** The server id once uploaded; a local temp id while `status: 'uploading'`. */
  key: string;
  name: string;
  kind: AttachmentKind;
  mimeType?: string;
  /** Set once uploaded — where the chip's `<img>`/link points. */
  url?: string;
  /** Local object URL for the thumbnail preview; revoked on remove/unmount. */
  previewUrl?: string;
  /** The original `File`, kept for Retry. Absent for an entry another surface added. */
  file?: File;
  status: 'uploading' | 'uploaded' | 'failed';
}

interface ComposerAttachmentState {
  byKey: Record<string, DraftAttachment[]>;
  /** Attach `files` to `draftKey`, uploading each immediately. */
  attach(draftKey: string, target: AttachmentTarget, files: File[]): void;
  /** Retry a failed upload — re-sends the same kept `File`. */
  retry(draftKey: string, target: AttachmentTarget, key: string): void;
  /** Remove a chip: DELETEs it server-side if uploaded, then drops it locally. */
  remove(draftKey: string, target: AttachmentTarget, key: string): void;
  /** Swap a chip's underlying file in place (markup editor) — keeps the same
   *  key/status and re-uploads, same as attaching fresh but without a new chip. */
  replaceFile(draftKey: string, target: AttachmentTarget, key: string, file: File): void;
  /** Bookkeeping-only: drop every entry for `draftKey` WITHOUT deleting
   *  server-side bytes — called right after a send already told the server to
   *  detach (the files now belong to the sent message). */
  detachAll(draftKey: string): DraftAttachment[];
  /** Like `detachAll`, for just the entries in `keys` (what a send took);
   *  anything attached since stays on the draft. */
  detach(draftKey: string, keys: string[]): DraftAttachment[];
  /** Discard every entry for `draftKey`, deleting each server-side too — a
   *  genuine "nothing kept" case (unlike `detachAll`). */
  discardAll(draftKey: string, target: AttachmentTarget): void;
  /** Wire intake: the account's full attachment snapshot for every draft key
   *  (sent once after auth.ok, folded into `composer_draft.list` /
   *  `new_chat_draft.list`). */
  applyList(
    entries: { draftKey: string; attachments: DraftAttachmentRef[] }[],
    kind: AttachmentTarget['kind'],
  ): void;
  /** Wire intake: `draftKey`'s attachment list changed, from any surface
   *  (including this one's own echo). */
  applyAttachmentsChanged(draftKey: string, attachments: DraftAttachmentRef[]): void;
  /** Test seam. */
  _reset(): void;
}

/** A stable empty list, so a selector for a key with nothing never re-renders. */
export const NO_ATTACHMENTS: DraftAttachment[] = [];

/** `draftKey::key` of files sent while still uploading — see `runUpload`. */
const sentWhileUploading = new Set<string>();

/** `draftKey::localKey` to the server id the file took on landing, so a caller
 *  holding the key from before the upload finished can still name it. */
const landedAs = new Map<string, string>();

/** Which kind of draft each key belongs to, so a snapshot of one kind never touches the other's. */
const keyKinds = new Map<string, AttachmentTarget['kind']>();

let seq = 0;
function tempKey(): string {
  seq += 1;
  return `local-${Date.now()}-${seq}`;
}

function kindForFile(file: File): AttachmentKind {
  return file.type.startsWith('image/') ? 'image' : 'file';
}

function refToEntry(ref: DraftAttachmentRef): DraftAttachment {
  return {
    key: ref.id,
    name: ref.name,
    kind: ref.kind,
    mimeType: ref.mimeType,
    url: ref.url,
    status: 'uploaded',
  };
}

async function doUpload(
  target: AttachmentTarget,
  file: File,
): Promise<{ ok: true; ref: DraftAttachmentRef }> {
  const model = file.type.startsWith('image/') ? await downscaleImageFile(file) : file;
  const modelArg = model === file ? undefined : model;
  return target.kind === 'chat'
    ? api.uploadAttachment(target.chatId, file, modelArg)
    : api.uploadNewChatDraftAttachment(target.draftId, file, modelArg);
}

function doDelete(target: AttachmentTarget, id: string): Promise<unknown> {
  return target.kind === 'chat'
    ? api.deleteAttachment(target.chatId, id)
    : api.deleteNewChatDraftAttachment(target.draftId, id);
}

export const useComposerAttachmentStore = create<ComposerAttachmentState>((set, get) => ({
  byKey: {},

  attach(draftKey, target, files) {
    if (files.length === 0) return;
    keyKinds.set(draftKey, target.kind);
    const entries: DraftAttachment[] = files.map((file) => ({
      key: tempKey(),
      name: file.name || (kindForFile(file) === 'image' ? 'image' : 'file'),
      kind: kindForFile(file),
      mimeType: file.type || undefined,
      file,
      previewUrl: kindForFile(file) === 'image' ? URL.createObjectURL(file) : undefined,
      status: 'uploading',
    }));
    set((s) => ({ byKey: { ...s.byKey, [draftKey]: [...(s.byKey[draftKey] ?? []), ...entries] } }));
    for (const entry of entries) trackUpload(draftKey, target, entry.key);
  },

  retry(draftKey, target, key) {
    const entry = get().byKey[draftKey]?.find((a) => a.key === key);
    if (!entry || !entry.file) return;
    set((s) => ({
      byKey: {
        ...s.byKey,
        [draftKey]: (s.byKey[draftKey] ?? []).map((a) =>
          a.key === key ? { ...a, status: 'uploading' as const } : a,
        ),
      },
    }));
    trackUpload(draftKey, target, key);
  },

  remove(draftKey, target, key) {
    const entry = get().byKey[draftKey]?.find((a) => a.key === key);
    set((s) => {
      const remaining = (s.byKey[draftKey] ?? []).filter((a) => a.key !== key);
      const byKey = { ...s.byKey };
      if (remaining.length === 0) delete byKey[draftKey];
      else byKey[draftKey] = remaining;
      return { byKey };
    });
    if (entry?.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    if (entry?.status === 'uploaded') {
      doDelete(target, key).catch((err: Error) => {
        useUiStore.getState().pushError(`couldn’t remove attachment: ${err.message}`);
      });
    }
  },

  replaceFile(draftKey, target, key, file) {
    set((s) => ({
      byKey: {
        ...s.byKey,
        [draftKey]: (s.byKey[draftKey] ?? []).map((a) => {
          if (a.key !== key) return a;
          if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
          return {
            ...a,
            file,
            name: file.name,
            previewUrl: URL.createObjectURL(file),
            status: 'uploading' as const,
          };
        }),
      },
    }));
    // A markup edit on an already-uploaded image supersedes the old server
    // copy — remove it (best-effort) before uploading the replacement so a
    // discard-before-the-new-upload-lands never leaves the stale one behind.
    void doDelete(target, key).catch(() => {
      // Best-effort only: if it was still `uploading` there was nothing
      // server-side yet, and either way the fresh upload below is what
      // matters.
    });
    trackUpload(draftKey, target, key);
  },

  detach(draftKey, keys) {
    const sent = new Set(keys.map((k) => landedAs.get(`${draftKey}::${k}`) ?? k));
    const removed = (get().byKey[draftKey] ?? []).filter((a) => sent.has(a.key));
    for (const a of removed)
      if (a.status === 'uploading') sentWhileUploading.add(`${draftKey}::${a.key}`);
    // NOT revoked, as in `detachAll`: the preview now belongs to the message.
    set((s) => {
      const byKey = { ...s.byKey };
      const rest = (byKey[draftKey] ?? []).filter((a) => !sent.has(a.key));
      if (rest.length === 0) delete byKey[draftKey];
      else byKey[draftKey] = rest;
      return { byKey };
    });
    return removed;
  },

  detachAll(draftKey) {
    const removed = get().byKey[draftKey] ?? [];
    // NOT revoked — the preview now belongs to the message just sent, drawn
    // in the stream from the very same object URL (spec/14 & spec/15 §
    // Composer → Attachments).
    set((s) => {
      const byKey = { ...s.byKey };
      delete byKey[draftKey];
      return { byKey };
    });
    return removed;
  },

  discardAll(draftKey, target) {
    const removed = get().byKey[draftKey] ?? [];
    for (const a of removed) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    set((s) => {
      const byKey = { ...s.byKey };
      delete byKey[draftKey];
      return { byKey };
    });
    for (const a of removed) {
      if (a.status === 'uploaded') {
        doDelete(target, a.key).catch(() => {
          // Best-effort — the draft is being discarded outright either way.
        });
      }
    }
  },

  applyList(entries, kind) {
    // The snapshot is authoritative for ONE kind of draft (chat composers or
    // new-chat drafts — they arrive as separate events), so only keys of that
    // kind are reconciled; a kind-key absent from the snapshot holds nothing.
    const listed = new Set(entries.map((e) => e.draftKey));
    for (const e of entries) keyKinds.set(e.draftKey, kind);
    for (const key of Object.keys(get().byKey)) {
      if (!listed.has(key) && keyKinds.get(key) === kind) get().applyAttachmentsChanged(key, []);
    }
    for (const e of entries) get().applyAttachmentsChanged(e.draftKey, e.attachments);
  },

  applyAttachmentsChanged(draftKey, attachments) {
    const current = get().byKey[draftKey] ?? [];
    // Keep every LOCAL entry still `uploading` (it has no server id yet, so
    // it can't appear in `attachments` regardless) or `failed` (a failed
    // upload was never registered server-side, so a snapshot naturally omits
    // it too) — only reconcile the uploaded ones against the authoritative
    // list, and revoke previews for any that got removed elsewhere.
    const remoteIds = new Set(attachments.map((a) => a.id));
    const keptLocal = current.filter((a) => a.status !== 'uploaded');
    for (const a of current) {
      if (a.status === 'uploaded' && !remoteIds.has(a.key) && a.previewUrl) {
        URL.revokeObjectURL(a.previewUrl);
      }
    }
    const stillUploaded = current.filter((a) => a.status === 'uploaded' && remoteIds.has(a.key));
    const known = new Set(stillUploaded.map((a) => a.key));
    const added = attachments.filter((a) => !known.has(a.id)).map(refToEntry);
    const merged = [
      ...stillUploaded.map((a) => {
        // Preserve the local previewUrl (this surface's own upload) over the
        // bare server ref — nothing to gain from swapping to the remote url.
        const ref = attachments.find((r) => r.id === a.key);
        return ref ? { ...a, url: ref.url } : a;
      }),
      ...added,
      ...keptLocal,
    ];
    set((s) => {
      const byKey = { ...s.byKey };
      if (merged.length === 0) delete byKey[draftKey];
      else byKey[draftKey] = merged;
      return { byKey };
    });
  },

  _reset() {
    for (const list of Object.values(get().byKey)) {
      for (const a of list) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
    set({ byKey: {} });
    // Drop any in-flight upload tracking too — a promise left over from a
    // torn-down test (or, in production, a page navigated away before its
    // upload settled) must not resolve `waitForAttachmentUpload` for a
    // now-unrelated later call under the same draftKey/key.
    uploadPromises.clear();
    keyKinds.clear();
    sentWhileUploading.clear();
    landedAs.clear();
  },
}));

/**
 * In-flight upload promises, keyed by `draftKey::key` — lets a caller about
 * to SEND wait for an upload that's already running (attached moments ago,
 * still in flight) rather than starting a second one. `key` here is always
 * the entry's key AT THE TIME the upload started (the local temp id, while
 * `status: 'uploading'`) — it never drifts, because the map is only ever
 * read while that same status still holds, before `runUpload` renames the
 * entry to its server id on success. Each promise resolves (never rejects)
 * to the SETTLED entry — uploaded or failed — so a waiting caller gets back
 * exactly what it needs without a second store lookup by a key that may have
 * just changed underneath it.
 */
const uploadPromises = new Map<string, Promise<DraftAttachment | undefined>>();

function trackUpload(draftKey: string, target: AttachmentTarget, key: string): void {
  const promise = runUpload(draftKey, target, key);
  uploadPromises.set(`${draftKey}::${key}`, promise);
  void promise.finally(() => {
    if (uploadPromises.get(`${draftKey}::${key}`) === promise) {
      uploadPromises.delete(`${draftKey}::${key}`);
    }
  });
}

/**
 * Wait for `key`'s upload to settle (success or failure) if one is still
 * running, returning the settled entry; resolves to `undefined` otherwise
 * (already settled, or never started — e.g. an entry another surface added,
 * which has no local file to upload in the first place — the caller then
 * uses whatever's already in the store for that key). spec/14 & spec/15 § Composer → Attachments: "sending uses the already-uploaded
 * files rather than uploading again" applies even when Send is pressed
 * WHILE the attach-time upload is still in flight — the send waits for that
 * one, rather than kicking off a second.
 */
export function waitForAttachmentUpload(
  draftKey: string,
  key: string,
): Promise<DraftAttachment | undefined> {
  return uploadPromises.get(`${draftKey}::${key}`) ?? Promise.resolve(undefined);
}

async function runUpload(
  draftKey: string,
  target: AttachmentTarget,
  key: string,
): Promise<DraftAttachment | undefined> {
  const entry = useComposerAttachmentStore.getState().byKey[draftKey]?.find((a) => a.key === key);
  if (!entry?.file) return entry;
  try {
    const { ref } = await doUpload(target, entry.file);
    const updated: DraftAttachment = {
      ...entry,
      key: ref.id,
      mimeType: ref.mimeType,
      url: ref.url,
      status: 'uploaded',
    };
    landedAs.set(`${draftKey}::${key}`, ref.id);
    if (!useComposerAttachmentStore.getState().byKey[draftKey]?.some((a) => a.key === key)) {
      // Left the draft while it uploaded. Sent: the message now owns it, so
      // only the draft's listing goes (an existing chat's; a new-chat draft
      // is promoted whole). Removed or replaced: nothing wants it, so it is deleted.
      const wasSent = sentWhileUploading.delete(`${draftKey}::${key}`);
      const settle = wasSent
        ? target.kind === 'chat'
          ? api.detachAttachments(target.chatId, [ref.id])
          : Promise.resolve()
        : doDelete(target, ref.id);
      settle.catch((err: Error) => {
        useUiStore.getState().pushError(`couldn’t release the draft’s attachments: ${err.message}`);
      });
      return updated;
    }
    useComposerAttachmentStore.setState((s) => ({
      byKey: {
        ...s.byKey,
        [draftKey]: (s.byKey[draftKey] ?? []).map((a) => (a.key === key ? updated : a)),
      },
    }));
    return updated;
  } catch (err) {
    const updated: DraftAttachment = { ...entry, status: 'failed' };
    useComposerAttachmentStore.setState((s) => ({
      byKey: {
        ...s.byKey,
        [draftKey]: (s.byKey[draftKey] ?? []).map((a) => (a.key === key ? updated : a)),
      },
    }));
    useUiStore.getState().pushError(`attachment upload failed: ${(err as Error).message}`);
    return updated;
  }
}
