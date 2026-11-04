// Outgoing turns, from Send to delivery (spec/15 § Composer → Attachments).
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
// unmounting — the user leaving the chat, or the new-chat screen replacing
// itself with the chat it just created — and so Retry / × work from the
// transcript.
//
// ORDER: turns reach delivery in the order they were sent, per chat. A turn
// sent behind one still uploading (text or attachments) is echoed at once but
// waits in that chat's chain. A FAILED upload leaves the chain — it must not
// hold up the turns behind it — and stays in the stream as `Not uploaded` with
// Retry (upload the same files again, then send; it rejoins the chain at the
// back) and × (discard). NO FALLBACK: nothing is dropped without the user
// discarding it, and every failure is toasted.

import type { AttachmentRef } from '@patch/wire';
import { api } from '../api/rest';
import { getWs } from '../api/ws';
import { useChatStore } from '../stores/chatStore';
import { useToolsStore } from '../stores/toolsStore';
import { useUiStore } from '../stores/uiStore';
import { deliveryTracker } from './deliveryTracker';
import { downscaleImage } from './imageResize';
import { apiUrl } from '../config';

/**
 * A file a turn is sent with, as the composer hands it over at Send. `uri` is
 * the local copy — absent when this device never had the bytes itself (step
 * 3 of 3: an attachment another surface put on the draft, sent from here).
 * `ref` is set once the file is known to be uploaded already (attach-time
 * upload, or a cross-surface attachment): present, `upload()` uses it
 * straight away instead of re-uploading. `refPromise` covers the race in
 * between — Send pressed while the attach-time upload is still in flight
 * (or a new-chat draft's promote-after-wait): the composer builds whichever
 * wait this file needs, and `upload()` just awaits it.
 */
export interface OutgoingFile {
  uri?: string;
  /** Served URL — the fallback local-echo source when `uri` is absent (a
   *  remote-only attachment, step 3 of 3): rendered from THIS instead of
   *  nothing while the ref itself is still resolving. */
  url?: string;
  name: string;
  mimeType: string;
  kind: 'image' | 'file';
  width?: number;
  height?: number;
  ref?: AttachmentRef;
  refPromise?: Promise<AttachmentRef>;
}

interface Outgoing {
  chatId: string;
  localId: string;
  text: string;
  files: OutgoingFile[];
  /** The Tools panel's OFF set captured at SEND time (see deliveryTracker). */
  disabledTools: string[];
  /** Original seq of the turn this re-runs: the host folds it into that bubble. */
  retryOfSeq?: number;
  /** The uploaded refs; `null` while the files are still uploading. */
  refs: AttachmentRef[] | null;
  /** Echoed but not yet cleared to deliver — a pre-send check is still running. */
  held: boolean;
  /** Withdrawn by `cancelHeld`: an upload still running for it must not touch the chain. */
  cancelled: boolean;
}

/** Per chat, the turns not yet handed to delivery, in send order. */
const chains = new Map<string, Outgoing[]>();
/** Turns whose upload failed, awaiting Retry or ×. */
const failed = new Map<string, Outgoing>();

let counter = 0;
const key = (chatId: string, localId: string): string => `${chatId} ${localId}`;

/**
 * Send a turn into `chatId`: echo it now, upload `files` (if any), deliver it
 * once everything ahead of it in the chat has. Returns the turn's localId.
 */
export function sendMessage(
  chatId: string,
  text: string,
  files: OutgoingFile[],
  opts: { hold?: boolean } = {},
): string {
  counter += 1;
  const localId = `m-${Date.now()}-${counter}`;
  // Step 3 of 3 (spec/14 & spec/15 § Composer → Attachments) — every file
  // already carries its ref when it was uploaded at ATTACH time: nothing to
  // upload, so skip the whole upload-staging dance and render exactly as an
  // ordinary resolved send would.
  const allResolved = files.length > 0 && files.every((f) => f.ref !== undefined);
  const item: Outgoing = {
    chatId,
    localId,
    text,
    files,
    disabledTools: useToolsStore.getState().disabledFor(chatId),
    refs: files.length === 0 ? [] : allResolved ? files.map((f) => f.ref!) : null,
    held: opts.hold === true,
    cancelled: false,
  };
  useChatStore.getState().appendLocalUserMessage(
    chatId,
    text,
    localId,
    allResolved ? item.refs! : undefined,
    allResolved
      ? undefined
      : {
          localAttachments: files.map((f) => ({
            // Falls back to the served URL for a remote-only attachment
            // (step 3 of 3 — another surface's, never downloaded here) —
            // `apiUrl` makes it absolute, since RN's `Image` (unlike a
            // browser) doesn't resolve a relative path against a base.
            uri: f.uri ?? (f.url ? apiUrl(f.url) : ''),
            name: f.name,
            mimeType: f.mimeType,
            kind: f.kind,
          })),
        },
  );
  enqueue(item);
  return localId;
}

/**
 * The user turn Retry re-runs for `entry`: the row itself when it is a user
 * message, or the nearest user message before it when it is an assistant
 * reply. Null when there is none to resend, or `entry` is not in the timeline.
 */
export function retrySource(
  chatId: string,
  entry: { role?: string; seq: number },
): { content: string; seq: number } | null {
  const tl = useChatStore.getState().timelines[chatId] ?? [];
  const at = tl.findIndex((e) => e.seq === entry.seq && e.role === entry.role);
  if (at < 0) return null;
  const upto = entry.role === 'user' ? tl.slice(at, at + 1) : tl.slice(0, at).reverse();
  const hit = upto.find(
    (e) =>
      e.kind === 'message' &&
      e.role === 'user' &&
      (e.content ?? '').length > 0 &&
      (e.attachments ?? []).length === 0,
  );
  return hit ? { content: hit.content ?? '', seq: hit.seq } : null;
}

/**
 * Retry a turn (see {@link retrySource}) by forking the conversation at it: the
 * user text runs again on a new track off the turn before it, and everything
 * from that turn down belongs to the track being left (spec/04 § Branching).
 */
export function retryTurn(chatId: string, entry: { role?: string; seq: number }): void {
  const src = retrySource(chatId, entry);
  if (!src) {
    useUiStore.getState().pushError('nothing to retry: no earlier text-only message');
    return;
  }
  forkAt(chatId, src.seq, src.content, 'retry');
}

/**
 * The user message Edit changes for `entry`: the row itself, only when it is a
 * settled text-only user message (attachments would be dropped by the fork).
 */
export function editSource(
  chatId: string,
  entry: { role?: string; seq: number },
): { content: string; seq: number } | null {
  if (entry.role !== 'user') return null;
  const tl = useChatStore.getState().timelines[chatId] ?? [];
  const hit = tl.find((e) => e.seq === entry.seq && e.kind === 'message' && e.role === 'user');
  if (!hit || (hit.content ?? '').length === 0 || (hit.attachments ?? []).length > 0) return null;
  return { content: hit.content ?? '', seq: hit.seq };
}

/**
 * Edit a sent user message: fork the conversation at it with the new text, so
 * the edit runs on a new track off the turn before it (spec/04 § Branching).
 */
export function editTurn(chatId: string, seq: number, message: string): void {
  if (message.trim().length === 0) {
    useUiStore.getState().pushError('edit failed: a message cannot be empty');
    return;
  }
  forkAt(chatId, seq, message, 'edit');
}

function forkAt(chatId: string, seq: number, message: string, verb: 'retry' | 'edit'): void {
  try {
    getWs().send({
      type: 'chat.fork_request',
      chatId,
      seq,
      message,
      localId: `fork-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
  } catch (err) {
    useUiStore.getState().pushError(`${verb} failed: ${(err as Error).message}`);
    return;
  }
  useChatStore.setState((s) => ({
    timelines: {
      ...s.timelines,
      [chatId]: (s.timelines[chatId] ?? []).filter((e) => e.seq < seq),
    },
  }));
}

/**
 * Clear a turn sent with `hold` to deliver (its pre-send check passed). It
 * goes out as soon as everything ahead of it in the chat has.
 */
export function releaseHeld(chatId: string, localId: string): void {
  const item = chains.get(chatId)?.find((i) => i.localId === localId);
  if (!item) return;
  item.held = false;
  drain(chatId);
}

/**
 * Withdraw a turn sent with `hold` (its pre-send check refused it): out of the
 * stream and out of the chain, never delivered. Turns behind it carry on.
 */
export function cancelHeld(chatId: string, localId: string): void {
  const chain = chains.get(chatId);
  const item = chain?.find((i) => i.localId === localId);
  if (!chain || !item) return;
  item.cancelled = true;
  chain.splice(chain.indexOf(item), 1);
  useChatStore.getState().removeLocalMessage(chatId, localId);
  drain(chatId);
}

/** Retry: upload the same files again, then send (spec/15). */
export function retryUpload(chatId: string, localId: string): void {
  const item = failed.get(key(chatId, localId));
  if (!item) {
    // The files went with the process that picked them (the app restarted).
    // Say so rather than leave a Retry that does nothing.
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
  failed.delete(key(chatId, localId));
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
  while (chain.length > 0 && chain[0]!.refs !== null && !chain[0]!.held) {
    const item = chain.shift()!;
    deliveryTracker.submit(
      item.chatId,
      item.text,
      item.localId,
      item.refs!.length > 0 ? item.refs! : undefined,
      (e) => getWs().send(e),
      item.disabledTools,
      item.retryOfSeq,
    );
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
      // Step 3 of 3 — already uploaded (this device's own attach-time upload
      // resolved after Send was pressed, or a mixed batch where some files
      // came pre-resolved): nothing to upload, use the ref as-is.
      if (a.ref) {
        refs.push(a.ref);
        useChatStore.getState().patchLocalMessage(chatId, localId, {
          upload: { done: refs.length, total, failed: false },
        });
        continue;
      }
      // Step 3 of 3 — Send raced ahead of this file's own resolution: await
      // whatever the composer already has in flight for it instead of
      // starting a fresh upload for the same file.
      if (a.refPromise) {
        const p = a.refPromise;
        a.refPromise = undefined; // consumed — a Retry falls through below
        const ref = await p;
        refs.push(ref);
        useChatStore.getState().patchLocalMessage(chatId, localId, {
          upload: { done: refs.length, total, failed: false },
        });
        continue;
      }
      // spec/15 § Composer — downscale/compress images so they're within the
      // backend's vision limits. Non-images upload as-is.
      /* v8 ignore next -- defensive only: every OutgoingFile Composer builds carries `ref`, `refPromise`, or `uri` — never none of the three. */
      if (!a.uri) continue;
      const up =
        a.kind === 'image'
          ? await downscaleImage({
              uri: a.uri,
              name: a.name,
              mimeType: a.mimeType,
              width: a.width,
              height: a.height,
            })
          : { uri: a.uri, name: a.name, mimeType: a.mimeType };
      const { ref } = await api.uploadAttachment(chatId, up);
      refs.push({ id: ref.id, name: ref.name, mimeType: ref.mimeType, kind: ref.kind });
      useChatStore.getState().patchLocalMessage(chatId, localId, {
        upload: { done: refs.length, total, failed: false },
      });
    }
    if (item.cancelled) return;
    item.refs = refs;
    // Every file is up: from here it is an ordinary send.
    useChatStore.getState().patchLocalMessage(chatId, localId, {
      upload: undefined,
      attachments: refs,
      deliveryPending: true,
    });
  } catch (e) {
    if (item.cancelled) return;
    const chain = chains.get(chatId)!;
    chain.splice(chain.indexOf(item), 1);
    failed.set(key(chatId, localId), item);
    useChatStore.getState().patchLocalMessage(chatId, localId, {
      upload: { done: 0, total, failed: true },
    });
    useUiStore.getState().pushError(`attachment upload failed: ${(e as Error).message}`);
  }
  drain(chatId);
}

/** Test seam: forget every in-flight and failed turn. */
export function _resetSendQueue(): void {
  chains.clear();
  failed.clear();
}
