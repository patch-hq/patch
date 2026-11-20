// Cross-chat tool-call log, account-wide (Settings → Activity — "things agents
// did"). Each host sends every cross-chat tool call it runs through its outbox
// (`patch.tool_log.entry`, spec/01 § Host outbox), and the server keeps them
// here, so the log reads the same whether or not a host is online.
//
//   <dataDir>/tool-calls.jsonl
//
// Not fsync'd per line: this is observability, not transactional state.
// Trimmed on write rather than left to grow forever: once the file passes
// TOOL_LOG_MAX_FILE_BYTES it is rewritten holding only its newest
// TOOL_LOG_KEEP_ENTRIES lines.

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
import type { Logger } from 'pino';
import type { ToolLogEntry, WireEvent } from '@patch/wire';

export const TOOL_LOG_MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const TOOL_LOG_DEFAULT_PAGE_SIZE = 200;
export const TOOL_LOG_MAX_PAGE_SIZE = 500;
/** Trim trigger — the file is rewritten once it passes this size. */
export const TOOL_LOG_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** How many of the newest entries survive a trim. */
export const TOOL_LOG_KEEP_ENTRIES = 20_000;

export interface ToolLogQuery {
  since: number;
  until: number;
  /** Resume point from a previously truncated page. */
  cursor?: number;
  limit?: number;
}

export interface ToolLogEntryWithHost extends ToolLogEntry {
  hostId: string;
}

export interface ToolLogResult {
  entries: ToolLogEntryWithHost[];
  truncated: boolean;
  nextCursor?: number;
}

export interface ToolLogOptions {
  /** Where the log file lives. Absent keeps it in memory only. */
  dataDir?: string;
  logger: Pick<Logger, 'warn'>;
  now?: () => number;
  /** Overrides for tests. */
  maxFileBytes?: number;
  keepEntries?: number;
}

export class ToolLog {
  private readonly path: string | null;
  private readonly memory: ToolLogEntryWithHost[] = [];
  private readonly now: () => number;
  private readonly maxFileBytes: number;
  private readonly keepEntries: number;

  constructor(private readonly opts: ToolLogOptions) {
    this.now = opts.now ?? Date.now;
    this.maxFileBytes = opts.maxFileBytes ?? TOOL_LOG_MAX_FILE_BYTES;
    this.keepEntries = opts.keepEntries ?? TOOL_LOG_KEEP_ENTRIES;
    if (opts.dataDir) {
      mkdirSync(opts.dataDir, { recursive: true });
      this.path = join(opts.dataDir, 'tool-calls.jsonl');
    } else {
      this.path = null;
    }
  }

  /** Take a host frame; only `patch.tool_log.entry` is kept. */
  observe(event: WireEvent, hostId: string | null): void {
    if (event.type !== 'patch.tool_log.entry' || hostId === null) return;
    this.append({ ...event.entry, hostId });
  }

  append(entry: ToolLogEntryWithHost): void {
    if (this.path === null) {
      this.memory.push(entry);
      if (this.memory.length > this.keepEntries) this.memory.shift();
      return;
    }
    try {
      appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
      this.trimIfOversized();
    } catch (err) {
      this.opts.logger.warn({ err }, 'tool log: could not write an entry');
    }
  }

  private trimIfOversized(): void {
    const path = this.path as string;
    if (statSync(path).size <= this.maxFileBytes) return;
    const lines = readLines(path);
    const kept = lines.slice(Math.max(0, lines.length - this.keepEntries));
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8');
    renameSync(tmp, path);
  }

  /** Every entry with `since <= ts <= until`, oldest first. */
  private entriesIn(since: number, until: number): ToolLogEntryWithHost[] {
    const all: ToolLogEntryWithHost[] = [];
    if (this.path === null) {
      all.push(...this.memory);
    } else {
      for (const line of readLines(this.path)) {
        try {
          all.push(JSON.parse(line) as ToolLogEntryWithHost);
        } catch {
          continue; // A torn last line: observability, not transactional state.
        }
      }
    }
    // A host's outbox can deliver an older entry after newer ones from another host.
    return all.filter((e) => e.ts >= since && e.ts <= until).sort((a, b) => a.ts - b.ts);
  }

  query(q: ToolLogQuery): ToolLogResult {
    const until = Math.min(q.until, this.now());
    let since = Math.min(q.since, until);
    if (until - since > TOOL_LOG_MAX_WINDOW_MS) since = until - TOOL_LOG_MAX_WINDOW_MS;
    const limit = Math.min(
      Math.max(Math.trunc(q.limit ?? TOOL_LOG_DEFAULT_PAGE_SIZE), 1),
      TOOL_LOG_MAX_PAGE_SIZE,
    );
    const from = q.cursor !== undefined ? Math.max(q.cursor, since) : since;
    const all = this.entriesIn(from, until);
    const truncated = all.length > limit;
    let page = all.slice(0, limit);
    // A page must not end inside a run of equal timestamps, or what follows
    // the cut is skipped: end before the run and resume at it.
    let nextCursor: number | undefined;
    if (truncated) {
      const runTs = all[limit]!.ts;
      const runStart = page.findIndex((e) => e.ts === runTs);
      if (runStart > 0) {
        page = page.slice(0, runStart);
        nextCursor = runTs;
      } else if (runStart === 0) {
        // The run fills the page: return that instant in full.
        page = all.filter((e) => e.ts === runTs);
        nextCursor = runTs + 1;
      } else {
        nextCursor = page[page.length - 1]!.ts + 1;
      }
    }
    return { entries: page, truncated, ...(nextCursor !== undefined ? { nextCursor } : {}) };
  }
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);
}
