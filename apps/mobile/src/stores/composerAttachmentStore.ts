// Draft attachments (step 3 of 3 — spec/14 & spec/15 § Composer →
// Attachments): a file attached to an unsent draft uploads STRAIGHT AWAY and
// is registered on the server-held draft, so every open surface shows the
// same chip. Keyed by a "draft key" — an existing chat's chatId, or a
// new-chat draft's own id — the same key both `composer_draft.*` and
// `new_chat_draft.*` already use (mobile's `chatId` prop on Composer IS
// already this key: an existing chat's real chatId, or (when `sendTarget` is
// set) the new-chat draft's own id — see `components/Composer.tsx`).
//
// SERVER-OWNED, same reasoning as `lib/composerDraft.ts` /
// `stores/newChatDraftStore.ts`: the server is the source of truth for what a
// draft's attachments currently are. This store holds the LOCAL projection of
// that — one entry per attachment, each independently uploading/uploaded/
// failed — reconciled against the server's `composer_draft.attachments_changed`
// / `new_chat_draft.attachments_changed` broadcasts (and the `.list` snapshot
// after auth.ok).
//
// An entry an OTHER surface added arrives with no local `uri` to preview — it
// renders from its `url` instead. An entry THIS device just attached renders
// from its local `uri` while uploading, and keeps it after (nothing to
// revoke — RN doesn't use object URLs) so the chip never flashes on settling.
//
// NO FALLBACK: a failed upload keeps the chip, marked `failed`, with the
// local file held for Retry (existing pattern — spec/15 § Composer →
// Attachments). An attachment is never silently dropped.

import { create } from 'zustand';
import type { AttachmentKind, DraftAttachmentRef } from '@patch/wire';
import { api } from '../api/rest';
import { useUiStore } from './uiStore';
import { downscaleImage } from '../lib/imageResize';

/** Where a draft key's attachments upload to/serve from — the two draft
 *  kinds have different routes (spec/14 & spec/15 § Composer → Attachments):
 *  an existing chat's composer already has a chatId; a new-chat draft
 *  doesn't, until it's promoted on first send. */
export type AttachmentTarget =
  | { kind: 'chat'; chatId: string }
  | { kind: 'new-chat-draft'; draftId: string };

/** A file attached to a composer, uploading or uploaded. */
export interface PendingAttachment {
  /** The server id once uploaded; a local temp id while `status: 'uploading'`. */
  key: string;
  /** Local cache-file uri — absent for an entry another surface added. */
  uri?: string;
  name: string;
  mimeType: string;
  kind: AttachmentKind;
  /** Set once uploaded — what a remote-only chip renders from. */
  url?: string;
  /** Pixel dimensions when known (image picker) — lets the resize skip a probe. */
  width?: number;
  height?: number;
  status: 'uploading' | 'uploaded' | 'failed';
}

interface ComposerAttachmentState {
  byKey: Record<string, PendingAttachment[]>;
  /** Attach already-picked files to `draftKey`, uploading each immediately. */
  attach(
    draftKey: string,
    target: AttachmentTarget,
    files: Array<{ uri: string; name: string; mimeType: string; width?: number; height?: number }>,
  ): void;
  /** Retry a failed upload — re-sends the same kept local file. */
  retry(draftKey: string, target: AttachmentTarget, key: string): void;
  /** Remove a chip: DELETEs it server-side if uploaded, then drops it locally. */
  remove(draftKey: string, target: AttachmentTarget, key: string): void;
  /** Swap one attachment for a new local file in place (an annotated copy of
   *  an image): the new file uploads, and the old one is deleted server-side
   *  if it had been uploaded. Throws when `key` is not in the draft. */
  replace(
    draftKey: string,
    target: AttachmentTarget,
    key: string,
    file: { uri: string; name: string; mimeType: string; width?: number; height?: number },
  ): void;
  /** Bookkeeping-only: drop every entry for `draftKey` WITHOUT deleting
   *  server-side bytes — called right after a send already told the server to
   *  detach (the files now belong to the sent message). */
  detachAll(draftKey: string): PendingAttachment[];
  /** Like `detachAll`, for just the entries in `keys` (what a send took);
   *  anything attached since stays on the draft. */
  detach(draftKey: string, keys: string[]): PendingAttachment[];
  /** Wire intake: the account's attachment snapshot for every draft of one
   *  kind (sent once after auth.ok, as `composer_draft.attachments_list` and
   *  `new_chat_draft.attachments_list`). */
  applyList(
    entries: { draftKey: string; attachments: DraftAttachmentRef[] }[],
    kind: AttachmentTarget['kind'],
  ): void;
  /** Wire intake: `draftKey`'s attachment list changed, from any surface
   *  (including this device's own echo). */
  applyAttachmentsChanged(draftKey: string, attachments: DraftAttachmentRef[]): void;
  /** Test seam. */
  _reset(): void;
}

/** A stable empty list, so a selector for a key with nothing never re-renders. */
export const NO_ATTACHMENTS: PendingAttachment[] = [];

/** Which kind of draft each key belongs to, so a snapshot of one kind never touches the other's. */
const keyKinds = new Map<string, AttachmentTarget['kind']>();

/** `draftKey::key` of files sent while still uploading — see `runUpload`. */
const sentWhileUploading = new Set<string>();

/** `draftKey::localKey` to the server id the file took on landing, so a caller
 *  holding the key from before the upload finished can still name it. */
const landedAs = new Map<string, string>();

let seq = 0;
function tempKey(): string {
  seq += 1;
  return `local-${Date.now()}-${seq}`;
}

/** Which chip a MIME type draws: a thumbnail for images, a file glyph otherwise. */
export function attachmentKindForMime(mime: string): AttachmentKind {
  return mime.toLowerCase().startsWith('image/') ? 'image' : 'file';
}

/** A unique chip key, for a caller building a `PendingAttachment` directly
 *  (the share sheet — see `lib/sharePicker.ts`). */
export function newAttachmentKey(): string {
  return tempKey();
}

function refToEntry(ref: DraftAttachmentRef): PendingAttachment {
  return {
    key: ref.id,
    name: ref.name,
    mimeType: ref.mimeType,
    kind: ref.kind,
    url: ref.url,
    status: 'uploaded',
  };
}

async function doUpload(
  target: AttachmentTarget,
  file: { uri: string; name: string; mimeType: string; width?: number; height?: number },
): Promise<{ ok: true; ref: DraftAttachmentRef }> {
  const kind = attachmentKindForMime(file.mimeType);
  const up =
    kind === 'image'
      ? await downscaleImage({
          uri: file.uri,
          name: file.name,
          mimeType: file.mimeType,
          width: file.width,
          height: file.height,
        })
      : { uri: file.uri, name: file.name, mimeType: file.mimeType };
  return target.kind === 'chat'
    ? api.uploadAttachment(target.chatId, up)
    : api.uploadNewChatDraftAttachment(target.draftId, up);
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
    const entries: PendingAttachment[] = files.map((f) => ({
      key: tempKey(),
      uri: f.uri,
      name: f.name,
      mimeType: f.mimeType,
      kind: attachmentKindForMime(f.mimeType),
      width: f.width,
      height: f.height,
      status: 'uploading',
    }));
    set((s) => ({ byKey: { ...s.byKey, [draftKey]: [...(s.byKey[draftKey] ?? []), ...entries] } }));
    for (let i = 0; i < entries.length; i++)
      trackUpload(draftKey, target, entries[i]!.key, files[i]!);
  },

  retry(draftKey, target, key) {
    const entry = get().byKey[draftKey]?.find((a) => a.key === key);
    if (!entry?.uri) return;
    set((s) => ({
      byKey: {
        ...s.byKey,
        [draftKey]: (s.byKey[draftKey] ?? []).map((a) =>
          a.key === key ? { ...a, status: 'uploading' as const } : a,
        ),
      },
    }));
    trackUpload(draftKey, target, key, {
      uri: entry.uri,
      name: entry.name,
      mimeType: entry.mimeType,
      width: entry.width,
      height: entry.height,
    });
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
    if (entry?.status === 'uploaded') {
      doDelete(target, key).catch((err: Error) => {
        useUiStore.getState().pushError(`couldn’t remove attachment: ${err.message}`);
      });
    }
  },

  detach(draftKey, keys) {
    const sent = new Set(keys.map((k) => landedAs.get(`${draftKey}::${k}`) ?? k));
    const removed = (get().byKey[draftKey] ?? []).filter((a) => sent.has(a.key));
    for (const a of removed)
      if (a.status === 'uploading') sentWhileUploading.add(`${draftKey}::${a.key}`);
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
    set((s) => {
      const byKey = { ...s.byKey };
      delete byKey[draftKey];
      return { byKey };
    });
    return removed;
  },

  applyList(entries, kind) {
    // The snapshot is authoritative for ONE kind of draft (chat composers or
    // new-chat drafts arrive as separate events), so only keys of that kind
    // are reconciled; a key of that kind absent from the snapshot holds nothing.
    const listed = new Set(entries.map((e) => e.draftKey));
    for (const e of entries) keyKinds.set(e.draftKey, kind);
    for (const key of Object.keys(get().byKey)) {
      if (!listed.has(key) && keyKinds.get(key) === kind) get().applyAttachmentsChanged(key, []);
    }
    for (const e of entries) get().applyAttachmentsChanged(e.draftKey, e.attachments);
  },
  replace(draftKey, target, key, file) {
    const list = get().byKey[draftKey] ?? [];
    const old = list.find((a) => a.key === key);
    if (!old) throw new Error(`composerAttachmentStore: no attachment ${key} to replace`);
    const entry: PendingAttachment = {
      key: tempKey(),
      uri: file.uri,
      name: file.name,
      mimeType: file.mimeType,
      kind: attachmentKindForMime(file.mimeType),
      width: file.width,
      height: file.height,
      status: 'uploading',
    };
    set((s) => ({
      byKey: {
        ...s.byKey,
        [draftKey]: (s.byKey[draftKey] ?? []).map((a) => (a.key === key ? entry : a)),
      },
    }));
    if (old.status === 'uploaded') {
      doDelete(target, key).catch((err: Error) => {
        useUiStore.getState().pushError(`couldn’t remove attachment: ${err.message}`);
      });
    }
    trackUpload(draftKey, target, entry.key, file);
  },

  applyAttachmentsChanged(draftKey, attachments) {
    const current = get().byKey[draftKey] ?? [];
    // Keep every LOCAL entry still `uploading` (no server id yet, so it can't
    // appear in `attachments` regardless) or `failed` (never registered
    // server-side) — only reconcile the uploaded ones against the
    // authoritative list.
    const remoteIds = new Set(attachments.map((a) => a.id));
    const keptLocal = current.filter((a) => a.status !== 'uploaded');
    const stillUploaded = current.filter((a) => a.status === 'uploaded' && remoteIds.has(a.key));
    const known = new Set(stillUploaded.map((a) => a.key));
    const added = attachments.filter((a) => !known.has(a.id)).map(refToEntry);
    const merged = [
      ...stillUploaded.map((a) => {
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
    set({ byKey: {} });
    uploadPromises.clear();
    keyKinds.clear();
    sentWhileUploading.clear();
    landedAs.clear();
  },
}));

/**
 * In-flight upload promises, keyed by `draftKey::key` — lets a caller about
 * to SEND wait for an upload that's already running rather than starting a
 * second one. `key` is always the entry's key AT THE TIME the upload
 * started (the local temp id, while `status: 'uploading'`) — it never
 * drifts, because the map is only ever read while that same status holds.
 * Each promise resolves (never rejects) to the SETTLED entry.
 */
const uploadPromises = new Map<string, Promise<PendingAttachment | undefined>>();

function trackUpload(
  draftKey: string,
  target: AttachmentTarget,
  key: string,
  file: { uri: string; name: string; mimeType: string; width?: number; height?: number },
): void {
  const promise = runUpload(draftKey, target, key, file);
  uploadPromises.set(`${draftKey}::${key}`, promise);
  void promise.finally(() => {
    if (uploadPromises.get(`${draftKey}::${key}`) === promise) {
      uploadPromises.delete(`${draftKey}::${key}`);
    }
  });
}

/** Wait for `key`'s upload to settle if one is still running, returning the
 *  settled entry; resolves to `undefined` otherwise (already settled, or
 *  never started). Step 3 of 3 — "sending uses the already-uploaded files
 *  rather than uploading again" applies even when Send races ahead of the
 *  attach-time upload — the send waits for that one, rather than kicking
 *  off a second. */
export function waitForAttachmentUpload(
  draftKey: string,
  key: string,
): Promise<PendingAttachment | undefined> {
  return uploadPromises.get(`${draftKey}::${key}`) ?? Promise.resolve(undefined);
}

async function runUpload(
  draftKey: string,
  target: AttachmentTarget,
  key: string,
  file: { uri: string; name: string; mimeType: string; width?: number; height?: number },
): Promise<PendingAttachment | undefined> {
  try {
    const { ref } = await doUpload(target, file);
    const updated: PendingAttachment = {
      key: ref.id,
      uri: file.uri,
      name: ref.name,
      mimeType: ref.mimeType,
      kind: ref.kind,
      url: ref.url,
      width: file.width,
      height: file.height,
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
        // The server's broadcast for this file can beat the HTTP response, in
        // which case it was already added as a remote chip under `ref.id`;
        // this local entry (which owns the file) replaces it.
        [draftKey]: (s.byKey[draftKey] ?? [])
          .filter((a) => a.key === key || a.key !== ref.id)
          .map((a) => (a.key === key ? updated : a)),
      },
    }));
    return updated;
  } catch (err) {
    let updated: PendingAttachment | undefined;
    useComposerAttachmentStore.setState((s) => {
      const list = (s.byKey[draftKey] ?? []).map((a) => {
        if (a.key !== key) return a;
        updated = { ...a, status: 'failed' as const };
        return updated;
      });
      return { byKey: { ...s.byKey, [draftKey]: list } };
    });
    useUiStore.getState().pushError(`attachment upload failed: ${(err as Error).message}`);
    return updated;
  }
}
