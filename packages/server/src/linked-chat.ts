// The first message of a linked chat (spec/04 § Provider switches, § Moving
// to another host).
//
// A provider switch or a move to another host starts a new chat linked to the
// old one. Nothing reaches the new model except that chat's first message,
// which the user reads, edits and sends. This drafts its starting text from the
// server's record of the old chat: what it was, the last request and how the
// last reply ended, and anything still unanswered. Pure and deterministic, so
// it works while the old chat's host is offline and costs no model call.

import { compactModelLabel, headCodePoints, tailCodePoints, type WireEvent } from '@patch/wire';

/** Longest stretch of one message carried into the draft. */
export const DRAFT_REQUEST_CHARS = 2_000;
export const DRAFT_REPLY_CHARS = 3_000;

export interface LinkedDraftSource {
  /** The old chat's title, or null while it has none. */
  name: string | null;
  folder: string;
  hostName: string;
  model: string | null;
  /** The old chat's record, oldest first (`ChatLogStore.read`). */
  events: readonly WireEvent[];
}

function quote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
}

function head(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${headCodePoints(t, max)}…` : t;
}

function tail(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `…${tailCodePoints(t, max)}` : t;
}

/**
 * The drafted first message. The opening line names where it came from, so
 * the new model knows it is a continuation; the rest is the old chat's own
 * words, quoted, for the user to keep, trim or replace.
 */
export function draftLinkedMessage(src: LinkedDraftSource): string {
  let lastAnsweredRequest: string | null = null;
  let lastReply: string | null = null;
  let unanswered: string[] = [];
  let pendingRequest: string | null = null;
  for (const e of src.events) {
    if (e.type !== 'chat.message' || e.role === 'system') continue;
    if (e.role === 'user') {
      pendingRequest = e.content;
      unanswered.push(e.content);
    } else if (e.role === 'assistant' && e.content.trim().length > 0) {
      if (pendingRequest !== null) lastAnsweredRequest = pendingRequest;
      pendingRequest = null;
      lastReply = e.content;
      unanswered = [];
    }
  }
  const where = [
    src.model !== null ? compactModelLabel(src.model) : null,
    `on ${src.hostName}`,
    `in ${src.folder}`,
  ]
    .filter((p): p is string => p !== null)
    .join(' ');
  const title = src.name !== null && src.name.trim().length > 0 ? `"${src.name.trim()}"` : 'a chat';
  const parts = [
    `This continues ${title} (${where}). You can't see that chat: this message is everything that carries over.`,
  ];
  if (lastAnsweredRequest !== null) {
    parts.push(`The last thing I asked:\n${quote(head(lastAnsweredRequest, DRAFT_REQUEST_CHARS))}`);
  }
  if (lastReply !== null) {
    parts.push(`How the last reply ended:\n${quote(tail(lastReply, DRAFT_REPLY_CHARS))}`);
  }
  if (unanswered.length > 0) {
    const label = unanswered.length === 1 ? 'Still unanswered:' : 'Still unanswered, in order:';
    parts.push(
      `${label}\n${unanswered.map((u) => quote(head(u, DRAFT_REQUEST_CHARS))).join('\n\n')}`,
    );
  }
  return parts.join('\n\n');
}
