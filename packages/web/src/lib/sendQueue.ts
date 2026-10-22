// Outgoing turns, from Send to delivery (spec/15 § Composer → Attachments, the
// cross-surface contract; spec/14 § Composer → Attachments).
//
// Sending reacts at once whatever the message carries: the turn is echoed into
// the stream the moment Send is pressed, and a turn with attachments shows its
// LOCAL files there, marked `Uploading done/total`, while they upload. Only once
// every upload has landed is the turn handed to `deliveryTracker.submit` (same
// localId as the bubble) — from there it is an ordinary send (spec/12 §
// Guaranteed input delivery). The agent never gets a turn missing some of its
// attachments.
//
// This lives here, not in the Composer, so an upload survives the composer
// unmounting — leaving the chat, or the new-chat route handing over to the
// chat it just created — and so Retry / × work from the transcript.
//
// ORDER: turns reach delivery in the order they were sent, per chat. A turn
// sent behind one still uploading (text or attachments) is echoed at once but
// waits in that chat's chain. A FAILED upload leaves the chain — it must not
// hold up the turns behind it — and stays in the stream as `Not uploaded` with
// Retry (upload the same files again, then send; it rejoins the chain at the
// back) and × (discard). NO FALLBACK: nothing is dropped without the user
// discarding it, and every failure is toasted.

import type { AttachmentRef, WireEvent } from '@patch/wire';
import { api } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';
import { useToolsStore } from '../stores/toolsStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { deliveryTracker } from './deliveryTracker.js';
import { downscaleImageFile } from './imageResize.js';
import { failed as failedSentence } from './errorCopy.js';

/**
 * A file a turn is sent with. `file` is the local copy the user picked —
 * absent when this surface never had the bytes itself (an
 * attachment another surface put on the draft, sent from here). `ref` is set
 * once the file is known to be uploaded already (attach-time
 * upload, or a cross-surface attachment): present, `upload()` below uses it
 * straight away instead of re-uploading a byte. `refPromise` covers the race
 * in between — Send pressed while the attach-time upload is still in flight
 * (existing chat), or a new-chat draft's attachment that needs a promote
 * once its own upload lands: the composer builds whichever wait this
 * particular file needs, and `upload()` just awaits it instead of starting a
 * fresh `api.uploadAttachment` for the same file.
 */
export interface OutgoingFile {
  file?: File;
  name: string;
  kind: 'image' | 'file';
  /** Object URL of the local copy (images) — drawn in the stream while it uploads. */
  previewUrl?: string;
  ref?: AttachmentRef;
  refPromise?: Promise<AttachmentRef>;
}

export interface SendMessageOptions {
  /** The chat's folder — seeds the row of a chat the surface has not seen yet. */
  folder?: string;
  /** The socket to deliver on (the route's `ws`); retries use the live one. */
  send?: (event: WireEvent) => void;
  /** "Send, wait until agent finished": the host holds it until the running turn ends. */
  afterTurn?: boolean;
  /** Called once the turn has been handed to delivery (after any upload), e.g. to promote it. */
  onDelivered?: (localId: string) => void;
}

interface Outgoing {
  chatId: string;
  localId: string;
  text: string;
  files: OutgoingFile[];
  /** The Tools panel's OFF set captured at SEND time (see deliveryTracker). */
  disabledTools: string[];
  opts: SendMessageOptions;
  /** The uploaded refs; `null` while the files are still uploading. */
  refs: AttachmentRef[] | null;
}

/** Per chat, the turns not yet handed to delivery, in send order. */
const chains = new Map<string, Outgoing[]>();
/** Turns whose upload failed, awaiting Retry or ×. */
const failed = new Map<string, Outgoing>();

const key = (chatId: string, localId: string): string => `${chatId} ${localId}`;

/**
 * Send a turn into `chatId`: echo it now, upload `files` (if any), deliver it
 * once everything ahead of it in the chat has. Returns the turn's localId.
 */
export function sendMessage(
  chatId: string,
  text: string,
  files: OutgoingFile[],
  opts: SendMessageOptions = {},
): string {
  const localId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // (spec/14 & spec/15 § Composer → Attachments) — every file
  // already carries its ref when it was uploaded at ATTACH time (this
  // surface's own upload, or another surface's, synced down before Send was
  // even pressed): nothing to upload, so skip the whole upload-staging dance
  // and render exactly as an ordinary resolved send would.
  const allResolved = files.length > 0 && files.every((f) => f.ref !== undefined);
  const item: Outgoing = {
    chatId,
    localId,
    text,
    files,
    disabledTools: useToolsStore.getState().disabledFor(chatId),
    opts,
    refs: files.length === 0 ? [] : allResolved ? files.map((f) => f.ref!) : null,
  };
  useChatStore.getState().addLocalMessage(
    chatId,
    text,
    localId,
    opts.folder,
    allResolved ? item.refs! : undefined,
    allResolved
      ? undefined
      : {
          localAttachments: files.map((f) => ({
            name: f.name,
            kind: f.kind,
            ...(f.previewUrl !== undefined ? { url: f.previewUrl } : {}),
          })),
        },
  );
  enqueue(item);
  return localId;
}

/** Retry: upload the same files again, then send. */
export function retryUpload(chatId: string, localId: string): void {
  const item = failed.get(key(chatId, localId));
  if (!item) {
    // The files went with the page that picked them (it reloaded). Say so
    // rather than leave a Retry that does nothing.
    useUiStore
      .getState()
      .pushError(
        'attachment upload failed: the files are no longer available — discard and resend',
      );
    return;
  }
  failed.delete(key(chatId, localId));
  useChatStore.getState().patchLocalMessage(chatId, localId, {
    upload: { done: 0, total: item.files.length, failed: false },
  });
  enqueue(item);
}

/** ×: discard a turn whose upload failed. */
export function discardUpload(chatId: string, localId: string): void {
  const item = failed.get(key(chatId, localId));
  failed.delete(key(chatId, localId));
  if (item) for (const f of item.files) if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
  useChatStore.getState().removeLocalMessage(chatId, localId);
}

function enqueue(item: Outgoing): void {
  const chain = chains.get(item.chatId) ?? [];
  chain.push(item);
  chains.set(item.chatId, chain);
  if (item.refs === null) void upload(item);
  drain(item.chatId);
}

/** Hand every turn at the head of the chain that is ready to delivery. */
function drain(chatId: string): void {
  // Only ever called for a chat with a chain: a turn stays in it until drained.
  const chain = chains.get(chatId)!;
  while (chain.length > 0 && chain[0]!.refs !== null) {
    const item = chain.shift()!;
    deliveryTracker.submit(
      item.chatId,
      item.text,
      item.localId,
      item.refs!.length > 0 ? item.refs! : undefined,
      item.opts.send,
      item.disabledTools,
      undefined,
      item.opts.afterTurn,
    );
    item.opts.onDelivered?.(item.localId);
  }
  if (chain.length === 0) chains.delete(chatId);
}

async function upload(item: Outgoing): Promise<void> {
  const { chatId, localId, files } = item;
  const total = files.length;
  try {
    const refs: AttachmentRef[] = [];
    // One at a time, so the count ticks visibly through a batch.
    for (const a of files) {
      // already uploaded (this surface's own attach-time upload
      // resolved after Send was pressed, or a mixed batch where some files
      // came pre-resolved): nothing to upload, use the ref as-is.
      if (a.ref) {
        refs.push(a.ref);
        useChatStore.getState().patchLocalMessage(chatId, localId, {
          upload: { done: refs.length, total, failed: false },
        });
        continue;
      }
      // Send raced ahead of this file's own resolution: await
      // whatever the composer already has in flight for it (an attach-time
      // upload still running, or a new-chat draft's promote-once-uploaded)
      // instead of starting a fresh `api.uploadAttachment` for the same
      // file. One attempt, fail fast on rejection — same as an ordinary
      // upload-on-send failure below (caught by this function's own
      // try/catch, which marks the WHOLE turn `Not uploaded`); the existing
      // Retry action re-enters `upload()` for a fresh attempt from `a.file`
      // if the user asks (by which point `refPromise` is stale and this
      // branch is skipped — Retry always rebuilds `OutgoingFile` from
      // scratch without one).
      if (a.refPromise) {
        // Consumed BEFORE awaiting — a Retry reuses this same `OutgoingFile`
        // object, and re-awaiting an already-settled (possibly rejected)
        // promise would repeat the exact same outcome forever. Cleared here
        // means a Retry instead falls through to an ordinary fresh upload
        // attempt from `a.file` below.
        const p = a.refPromise;
        a.refPromise = undefined;
        const ref = await p;
        refs.push(ref);
        useChatStore.getState().patchLocalMessage(chatId, localId, {
          upload: { done: refs.length, total, failed: false },
        });
        continue;
      }
      // spec/15 § Composer — the ORIGINAL is uploaded (it is what gets stored,
      // served and rendered) alongside a downscaled copy for the agent, which
      // has to stay within Claude's vision limits. `downscaleImageFile` hands
      // back the very same File when no resize was needed, so an identity
      // result means there is no second copy to send — as with any non-image.
      if (!a.file)
        throw new Error(`attachment ${a.name} has neither an uploaded ref nor its bytes`);
      const downscaled = a.kind === 'image' ? await downscaleImageFile(a.file) : a.file;
      const model = downscaled === a.file ? undefined : downscaled;
      const { ref } = await api.uploadAttachment(chatId, a.file, model);
      refs.push({ id: ref.id, name: ref.name, mimeType: ref.mimeType, kind: ref.kind });
      useChatStore.getState().patchLocalMessage(chatId, localId, {
        upload: { done: refs.length, total, failed: false },
      });
    }
    item.refs = refs;
    // Every file is up: from here it is an ordinary send.
    useChatStore.getState().patchLocalMessage(chatId, localId, {
      upload: undefined,
      attachments: refs,
      deliveryPending: true,
    });
  } catch (e) {
    const chain = chains.get(chatId)!;
    chain.splice(chain.indexOf(item), 1);
    failed.set(key(chatId, localId), item);
    useChatStore.getState().patchLocalMessage(chatId, localId, {
      upload: { done: 0, total, failed: true },
    });
    useUiStore
      .getState()
      .pushError(failedSentence('attachment upload'), undefined, (e as Error).message);
  }
  drain(chatId);
}

/** Test seam: forget every in-flight and failed turn. */
export function _resetSendQueue(): void {
  chains.clear();
  failed.clear();
}
