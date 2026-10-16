// The user's own messages, read straight from the chats' history logs
// (spec/06 § `patch_activity`). A user message is a `chat.message` event with
// role 'user' in a chat's `events.jsonl` (spec/04 § History) — there is no
// second store of them.

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ActivityMessageKind } from '@patch/wire';

export interface UserMessageRow {
  chatId: string;
  text: string;
  ts: number;
  /**
   * What produced this row (spec/06 § `patch_activity`), absent when a
   * person actually typed it. Read off the same `jobTrigger`/`hookTrigger`/
   * `goalTrigger`/`origin` flags a surface already uses to render a turn as
   * transcript furniture instead of a bubble — see `ActivityMessageKind` for
   * what each value means. Checked in that order: a turn already flagged
   * `jobTrigger`/`hookTrigger`/`goalTrigger` is reported as that, even though
   * the goal/hook paths also set `origin: 'machine'` — the more specific
   * reason wins.
   */
  kind?: ActivityMessageKind;
}

const READ_CHUNK = 256 * 1024;

/** Feed `onLine` every complete line of a file, without holding the whole file. */
function forEachLine(path: string, onLine: (line: string) => void): void {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(READ_CHUNK);
    // Holds a multibyte character split across two reads until its tail arrives.
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
 * Every user message with `since <= createdAt <= until` across the chats under
 * `chatsRoot`, oldest first, at most `limit` of them. A chat whose log was last
 * written before `since` cannot hold one, so it is skipped unread. A message
 * the log holds twice (the same text at the same instant in one chat — a branch
 * copy) is reported once.
 */
export function readUserMessages(
  chatsRoot: string,
  since: number,
  until: number,
  limit: number,
): UserMessageRow[] {
  const rows: UserMessageRow[] = [];
  for (const chatId of readdirSync(chatsRoot)) {
    const path = join(chatsRoot, chatId, 'events.jsonl');
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    if (mtimeMs < since) continue;
    const seen = new Set<string>();
    forEachLine(path, (line) => {
      if (!line.includes('"role":"user"')) return;
      let rec: { rec?: { event?: Record<string, unknown> } };
      try {
        rec = JSON.parse(line);
      } catch {
        // A torn tail line (spec/04 § History repairs it on open) — not a record.
        return;
      }
      const ev = rec.rec?.event;
      if (ev?.type !== 'chat.message' || ev.role !== 'user') return;
      const ts = ev.createdAt;
      const text = ev.content;
      if (typeof ts !== 'number' || typeof text !== 'string') return;
      if (ts < since || ts > until) return;
      const key = `${ts}\u0000${text}`;
      if (seen.has(key)) return;
      seen.add(key);
      const kind: ActivityMessageKind | undefined =
        ev.jobTrigger === true
          ? 'job'
          : ev.hookTrigger !== undefined
            ? 'hook'
            : ev.goalTrigger !== undefined
              ? 'goal'
              : ev.origin === 'machine'
                ? 'machine'
                : undefined;
      rows.push({ chatId, text, ts, ...(kind !== undefined ? { kind } : {}) });
    });
  }
  rows.sort((a, b) => a.ts - b.ts);
  return rows.slice(0, limit);
}
