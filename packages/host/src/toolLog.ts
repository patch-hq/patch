// Cross-chat tool-call log — "things agents did" (Settings → Activity).
//
// Every `patch_*` cross-chat tool call already reaches `control.ts`'s
// `toolLogger` hook (tool, callerChatId, targetChatId, durationMs, ok, err).
// Until now that hook only reached the structured process logger
// (`daemon.log`), which nothing in the product reads back — so a chat that
// got unhidden by a stray `patch_send_to` with no caller context had no
// durable, queryable record of what happened or who was asking. This module
// gives that hook a second, durable destination: one bounded, append-only
// JSONL file per machine, read the same way job runs and webhook logs are
// (`packages/server/src/jobs/logs.ts`).
//
//   <patchHome>/logs/tool-calls.jsonl
//
// Not fsync'd per line — this is observability, not transactional state,
// same reasoning as job runs.jsonl. Trimmed on write rather than left to grow
// forever: once the file passes MAX_FILE_BYTES it is rewritten holding only
// its newest KEEP_ENTRIES lines.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface ToolLogEntry {
  ts: number;
  tool: string;
  callerChatId?: string;
  targetChatId?: string;
  durationMs: number;
  ok: boolean;
  err?: string;
}

/** Trim trigger — the file is rewritten once it passes this size. */
export const TOOL_LOG_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** How many of the newest entries survive a trim. */
export const TOOL_LOG_KEEP_ENTRIES = 5_000;

export interface ToolLogStoreOptions {
  /** Trim trigger, overriding {@link TOOL_LOG_MAX_FILE_BYTES} — tests only. */
  maxFileBytes?: number;
  /** Lines kept on a trim, overriding {@link TOOL_LOG_KEEP_ENTRIES} — tests only. */
  keepEntries?: number;
}

export class ToolLogStore {
  private readonly path: string;
  private readonly maxFileBytes: number;
  private readonly keepEntries: number;

  constructor(patchHome: string, opts: ToolLogStoreOptions = {}) {
    const dir = join(patchHome, 'logs');
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, 'tool-calls.jsonl');
    this.maxFileBytes = opts.maxFileBytes ?? TOOL_LOG_MAX_FILE_BYTES;
    this.keepEntries = opts.keepEntries ?? TOOL_LOG_KEEP_ENTRIES;
  }

  append(entry: ToolLogEntry): void {
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
    this.trimIfOversized();
  }

  private trimIfOversized(): void {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return;
    }
    if (size <= this.maxFileBytes) return;
    const lines = readLines(this.path);
    const kept = lines.slice(Math.max(0, lines.length - this.keepEntries));
    const tmp = `${this.path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8');
    renameSync(tmp, this.path);
  }

  /**
   * Entries with `since <= ts <= until`, oldest first, capped at `limit` —
   * same cursor-friendly shape `readUserMessages` returns for `patch_activity`
   * (see `activity.ts`'s "oldest `limit` in the window").
   */
  readEntries(since: number, until: number, limit: number): ToolLogEntry[] {
    const out: ToolLogEntry[] = [];
    for (const line of readLines(this.path)) {
      let entry: ToolLogEntry;
      try {
        entry = JSON.parse(line) as ToolLogEntry;
      } catch {
        continue; // Not an entry — observability log, not transactional state.
      }
      if (entry.ts < since || entry.ts > until) continue;
      out.push(entry);
      if (out.length >= limit) break;
    }
    return out;
  }
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);
}
