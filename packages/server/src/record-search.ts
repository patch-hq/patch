// Searching the text of the server's chat record (spec/03 § Chat search).
//
// A chat whose host is offline is searched here, from the record the server
// already keeps for every chat (`chat-log-store.ts`), so nothing else has to
// hold a second copy of what was said.
//
// Only user and assistant message text is kept in memory, never the rest of a
// record (tool calls, results). A chat's file is read once, then only the bytes
// appended since, so a repeat search costs a stat per chat rather than a parse.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { makeSnippet, type ChatSearchSnippet, type WireEvent } from '@patch/wire';

export interface RecordMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Lowercased, whitespace collapsed, so a phrase matches across a line break. */
  lower: string;
}

export interface RecordMatch {
  messageMatches: number;
  snippet: ChatSearchSnippet;
}

/** Lowercased, whitespace collapsed — so a phrase matches across a line break. */
export const matchForm = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ');

/** The searchable form of a record entry, or null for anything that is not a spoken message. */
export function searchableMessage(event: WireEvent): RecordMessage | null {
  if (event.type !== 'chat.message') return null;
  if (event.role !== 'user' && event.role !== 'assistant') return null;
  if (typeof event.content !== 'string' || event.content.length === 0) return null;
  return { role: event.role, content: event.content, lower: matchForm(event.content) };
}

/** Messages containing every term; the newest is the snippet. `null` for none. */
export function matchMessages(
  messages: Iterable<[number, RecordMessage]>,
  terms: string[],
): RecordMatch | null {
  if (terms.length === 0) return null;
  let matches = 0;
  let latestSeq = -1;
  let latest: RecordMessage | null = null;
  for (const [seq, m] of messages) {
    if (!terms.every((t) => m.lower.includes(t))) continue;
    matches++;
    if (seq >= latestSeq) {
      latestSeq = seq;
      latest = m;
    }
  }
  if (latest === null) return null;
  const { text, highlights } = makeSnippet(latest.content, terms);
  // The record keeps no time per message; a surface shows the chat's own time.
  return {
    messageMatches: matches,
    snippet: { text, highlights, role: latest.role, seq: latestSeq, createdAt: null },
  };
}

interface FileIndex {
  /** Bytes of the file already taken in, always at a line boundary. */
  offset: number;
  messages: Map<number, RecordMessage>;
}

const MESSAGE_MARK = '"chat.message"';

/** The message text of each chat's record file, read incrementally. */
export class RecordTextIndex {
  private readonly files = new Map<string, FileIndex>();

  /** The chat's messages by seq, brought up to date with what was appended to `path`. */
  messages(path: string): Map<number, RecordMessage> {
    let held = this.files.get(path);
    let fd: number;
    try {
      fd = openSync(path, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.files.delete(path);
        return new Map();
      }
      throw err;
    }
    try {
      const size = fstatSync(fd).size;
      // A file that shrank was replaced: start again.
      if (!held || size < held.offset) {
        held = { offset: 0, messages: new Map() };
        this.files.set(path, held);
      }
      if (size === held.offset) return held.messages;
      const buf = Buffer.alloc(size - held.offset);
      let read = 0;
      while (read < buf.length) {
        const n = readSync(fd, buf, read, buf.length - read, held.offset + read);
        if (n === 0) break;
        read += n;
      }
      // Only whole lines: a torn last line is taken once its newline lands.
      const end = buf.lastIndexOf(0x0a, read - 1);
      if (end === -1) return held.messages;
      const text = buf.toString('utf8', 0, end + 1);
      held.offset += end + 1;
      for (const line of text.split('\n')) {
        if (line === '' || !line.includes(MESSAGE_MARK)) continue;
        let event: WireEvent;
        try {
          event = JSON.parse(line) as WireEvent;
        } catch {
          // The log store skips a corrupt line on load; search does the same.
          continue;
        }
        const seq = (event as { seq?: unknown }).seq;
        if (typeof seq !== 'number') continue;
        const message = searchableMessage(event);
        // An update at a seq replaces what was there, as it does in the log.
        if (message) held.messages.set(seq, message);
        else held.messages.delete(seq);
      }
      return held.messages;
    } finally {
      closeSync(fd);
    }
  }
}
