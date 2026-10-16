// Cross-chat tool-call log, account-wide (Settings → Activity — "things
// agents did"). Mirrors activity.ts exactly: there is no central store, each
// machine keeps its own bounded `tool-calls.jsonl` (packages/host/src/
// toolLog.ts), and this is a read-through that asks every online machine for
// its entries in the window and merges the answers. NO FALLBACK: a machine
// that is offline or does not answer fails the call, because an answer
// missing one host's entries would look complete.

import { randomUUID } from 'node:crypto';
import type { PatchToolLogReadResponseEvent, ToolLogEntry } from '@patch/wire';
import type { HostLink } from './host-link.js';

export const TOOL_LOG_MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const TOOL_LOG_DEFAULT_PAGE_SIZE = 200;
export const TOOL_LOG_MAX_PAGE_SIZE = 500;
/** How long one machine has to scan its log before the whole call fails. */
export const TOOL_LOG_READ_TIMEOUT_MS = 30_000;

const READ_SURFACE_ID = 'tool-log-read';

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

export interface ToolLogReader {
  query(q: ToolLogQuery): Promise<ToolLogResult>;
  /** Stop listening and fail anything still waiting. */
  close(): void;
}

export function createToolLogReader(deps: {
  hostLink: HostLink;
  now?: () => number;
}): ToolLogReader {
  const { hostLink } = deps;
  const now = deps.now ?? Date.now;
  const waiting = new Map<
    string,
    { resolve: (e: PatchToolLogReadResponseEvent) => void; reject: (err: Error) => void }
  >();

  const unsubscribe = hostLink.onEvent((event) => {
    if (event.type !== 'patch.tool_log.read.response') return;
    const w = waiting.get(event.requestId);
    if (w) w.resolve(event);
  });

  const readHost = (
    hostId: string,
    since: number,
    until: number,
    limit: number,
  ): Promise<PatchToolLogReadResponseEvent> =>
    new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        waiting.delete(requestId);
        reject(
          new Error(
            `tool log: machine ${hostId} did not answer within ${TOOL_LOG_READ_TIMEOUT_MS / 1000}s`,
          ),
        );
      }, TOOL_LOG_READ_TIMEOUT_MS);
      timer.unref();
      waiting.set(requestId, {
        resolve: (e) => {
          clearTimeout(timer);
          waiting.delete(requestId);
          resolve(e);
        },
        reject: (err) => {
          clearTimeout(timer);
          waiting.delete(requestId);
          reject(err);
        },
      });
      hostLink.sendTo(hostId, READ_SURFACE_ID, {
        type: 'patch.tool_log.read.request',
        requestId,
        since,
        until,
        limit,
      });
    });

  return {
    async query(q) {
      const until = Math.min(q.until, now());
      let since = Math.min(q.since, until);
      if (until - since > TOOL_LOG_MAX_WINDOW_MS) since = until - TOOL_LOG_MAX_WINDOW_MS;
      const limit = Math.min(
        Math.max(Math.trunc(q.limit ?? TOOL_LOG_DEFAULT_PAGE_SIZE), 1),
        TOOL_LOG_MAX_PAGE_SIZE,
      );
      const from = q.cursor !== undefined ? Math.max(q.cursor, since) : since;

      const hosts = hostLink.onlineHostIds();
      // Each machine returns its oldest `limit + 1` — enough to tell whether
      // the merged page is truncated without any machine sending its whole log.
      const answers = await Promise.all(hosts.map((h) => readHost(h, from, until, limit + 1)));
      const all = answers
        .flatMap((a) => a.entries.map((e) => ({ ...e, hostId: a.hostId })))
        .sort((a, b) => a.ts - b.ts);
      const truncated = all.length > limit;
      let page = all.slice(0, limit);
      // Same run-at-the-cut handling as activity.ts: a page must not end
      // inside a run of equal timestamps, or what follows the cut is skipped.
      let nextCursor: number | undefined;
      if (truncated) {
        const runTs = all[limit]!.ts;
        const runStart = page.findIndex((e) => e.ts === runTs);
        if (runStart > 0) {
          page = page.slice(0, runStart);
          nextCursor = runTs;
        } else if (runStart === 0) {
          const run = await Promise.all(
            hosts.map((h) => readHost(h, runTs, runTs, Number.MAX_SAFE_INTEGER)),
          );
          page = run.flatMap((a) => a.entries.map((e) => ({ ...e, hostId: a.hostId })));
          nextCursor = runTs + 1;
        } else {
          nextCursor = page[page.length - 1]!.ts + 1;
        }
      }

      return {
        entries: page,
        truncated,
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      };
    },
    close() {
      unsubscribe();
      for (const w of [...waiting.values()]) w.reject(new Error('tool log: server closing'));
    },
  };
}
