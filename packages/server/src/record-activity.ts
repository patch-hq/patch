// The user's own messages, read from the server's chat record (spec/06 §
// `patch_activity`). A user message is a `chat.message` event with role 'user'
// in a chat's record; there is no second store of them, and no host is asked.
//
// Not every `role: 'user'` row is a person typing: a job's fire, a hook/goal
// resubmit, or the host starting a turn itself (self-wake, a finished-chats delivery, a
// delegate relay, the todo list advancing) all land that way too. Each row's
// `kind` is read off the message's own flags — see `ActivityMessageKind`.

import { closeSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { ActivityMessageKind, WireEvent } from '@patch/wire';

export interface UserMessageRow {
  chatId: string;
  text: string;
  ts: number;
  /** Absent when a person typed it. */
  kind?: ActivityMessageKind;
}

/**
 * A cut-off turn re-sent after a host restart shows as a bare `Carry on` with
 * the restart note recorded just ahead of it. It keeps the original turn's
 * `origin`, so the note is the only marker that no person typed this text.
 */
function isRestartNote(ev: Record<string, unknown>): boolean {
  return (
    ev.type === 'chat.note' &&
    typeof ev.label === 'string' &&
    ev.label.startsWith('Turn interrupted by restart')
  );
}

/**
 * Collects the user messages of one chat's record, fed its events in seq order.
 * The same text at the same instant (a branch copy) is reported once.
 */
export class UserMessageCollector {
  private readonly seen = new Set<string>();
  private restartNoteSeen = false;

  constructor(
    private readonly since: number,
    private readonly until: number,
    private readonly out: UserMessageRow[],
  ) {}

  take(event: WireEvent | Record<string, unknown>): void {
    const ev = event as Record<string, unknown>;
    if (isRestartNote(ev)) {
      this.restartNoteSeen = true;
      return;
    }
    if (ev.type !== 'chat.message' || ev.role !== 'user') return;
    const afterRestartNote = this.restartNoteSeen;
    this.restartNoteSeen = false;
    const ts = ev.createdAt;
    const text = ev.content;
    const chatId = ev.chatId;
    if (typeof ts !== 'number' || typeof text !== 'string' || typeof chatId !== 'string') return;
    if (ts < this.since || ts > this.until) return;
    const key = `${ts}\u0000${text}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    // Checked in this order: a turn flagged as a job, hook or goal is reported
    // as that even though those paths also set `origin: 'machine'`.
    const kind: ActivityMessageKind | undefined =
      ev.jobTrigger === true
        ? 'job'
        : ev.hookTrigger !== undefined
          ? 'hook'
          : ev.goalTrigger !== undefined
            ? 'goal'
            : ev.origin === 'machine' || afterRestartNote
              ? 'machine'
              : undefined;
    this.out.push({ chatId, text, ts, ...(kind !== undefined ? { kind } : {}) });
  }
}

const READ_CHUNK = 256 * 1024;

/** Feed `onLine` every complete line of a file, without holding the whole file. */
export function forEachLine(path: string, onLine: (line: string) => void): void {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(READ_CHUNK);
    const decoder = new StringDecoder('utf8');
    let carry = '';
    for (;;) {
      const n = readSync(fd, buf, 0, READ_CHUNK, null);
      if (n === 0) break;
      const parts = (carry + decoder.write(buf.subarray(0, n))).split('\n');
      carry = parts.pop() ?? '';
      for (const line of parts) onLine(line);
    }
    carry += decoder.end();
    if (carry.length > 0) onLine(carry);
  } finally {
    closeSync(fd);
  }
}

/**
 * The user messages in one record file. Lines are events in the order they
 * were written; a later line for a seq replaces an earlier one, so the file is
 * read whole and laid out by seq before collecting. A subagent's record (it
 * names its parent) holds no message of the user's: its "user" turns are its
 * parent agent's instructions, so it is skipped.
 */
export function userMessagesInFile(
  path: string,
  since: number,
  until: number,
  out: UserMessageRow[],
): void {
  const bySeq = new Map<number, Record<string, unknown>>();
  let subagent = false;
  forEachLine(path, (line) => {
    if (line.startsWith('{"parent":')) subagent = true;
    if (subagent) return;
    if (!line.includes('"role":"user"') && !line.includes('"type":"chat.note"')) return;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // A torn last line from a crash: not an event.
    }
    if (typeof ev.seq === 'number') bySeq.set(ev.seq, ev);
  });
  if (subagent) return;
  const collector = new UserMessageCollector(since, until, out);
  for (const [, ev] of [...bySeq].sort((a, b) => a[0] - b[0])) collector.take(ev);
}
