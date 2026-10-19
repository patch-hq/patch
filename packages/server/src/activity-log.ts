// The user's chat dwell sessions (spec/06 § Cross-chat toolset — `patch_activity`).
//
// A dwell session is a period a chat sat open on a surface that was both
// focused (`chat.focus_change`) and visible (`surface.foregrounded`/
// `backgrounded`) — spec/05 § What counts as a chat being "open". Unlike the
// user's messages, which are read through each host's own chat log
// (`activity.ts`), no host keeps this: the server is the only place that sees
// every surface's focus/visibility frames regardless of which host a chat lives
// on, so ws-hub.ts records them here as they pass through.
//
// Persistence: a single append-only JSONL file at `<dataDir>/activity.jsonl`,
// the same pattern as the per-job run log (`jobs/logs.ts`) — observability,
// not transactional state, so appends are not fsync'd. Loaded fully into
// memory at startup (bounded by retention below) and compacted back to disk
// periodically so the file doesn't grow past what retention keeps live.

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTIVITY_DEFAULT_PAGE_SIZE,
  ACTIVITY_MAX_PAGE_SIZE,
  ACTIVITY_MAX_WINDOW_MS,
} from './activity.js';

export type StoredActivityEvent =
  | { kind: 'focus'; ts: number; surfaceId: string; chatId: string | null }
  | { kind: 'visibility'; ts: number; surfaceId: string; visible: boolean };

/** How long a raw event is kept at all, regardless of whether anything ever asks for it. */
export const ACTIVITY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Hard cap on stored raw events — a second, count-based bound independent of age. */
export const ACTIVITY_MAX_STORED_EVENTS = 50_000;

/** Rewrite the compacted file every this-many appends, bounding its growth between restarts. */
const COMPACT_EVERY = 500;

export interface RawChatSession {
  chatId: string;
  start: number;
  end: number;
  durationMs: number;
}

export interface SessionsQuery {
  since: number;
  until: number;
  /** Resume point from a previously truncated page. */
  sessionsCursor?: number;
  limit?: number;
}

export interface SessionsResult {
  chatSessions: RawChatSession[];
  sessionsTruncated: boolean;
  nextSessionsCursor?: number;
}

interface SurfaceState {
  chatId: string | null;
  visible: boolean;
  sessionStart: number | null;
  sessionChatId: string | null;
}

function isActive(s: SurfaceState): boolean {
  return s.visible && s.chatId !== null;
}

/**
 * Reconstruct per-chat dwell sessions — "focused AND visible" intervals —
 * from raw focus/visibility events, for the window `(since, until]` (state
 * as of `since` itself is established from events at-or-before it, then
 * clipped to open at `since`). Pure function: the tests exercise this
 * directly, with no filesystem involved.
 *
 * Two surfaces open on the same chat at once produce two session rows — that
 * is the truth (two windows were really open), not a duplicate to merge.
 */
export function computeChatSessions(
  focusEvents: Array<{ ts: number; surfaceId: string; chatId: string | null }>,
  visibilityEvents: Array<{ ts: number; surfaceId: string; visible: boolean }>,
  since: number,
  until: number,
): RawChatSession[] {
  type Tagged =
    | { kind: 'focus'; ts: number; surfaceId: string; chatId: string | null }
    | { kind: 'visibility'; ts: number; surfaceId: string; visible: boolean };
  const all: Tagged[] = [
    ...focusEvents.map((e) => ({ kind: 'focus' as const, ...e })),
    ...visibilityEvents.map((e) => ({ kind: 'visibility' as const, ...e })),
  ].sort((a, b) => a.ts - b.ts);

  const states = new Map<string, SurfaceState>();
  const getState = (surfaceId: string): SurfaceState => {
    let s = states.get(surfaceId);
    if (!s) {
      s = { chatId: null, visible: false, sessionStart: null, sessionChatId: null };
      states.set(surfaceId, s);
    }
    return s;
  };

  const sessions: RawChatSession[] = [];
  const closeSession = (s: SurfaceState, endTs: number): void => {
    if (s.sessionStart !== null && s.sessionChatId !== null && endTs > s.sessionStart) {
      sessions.push({
        chatId: s.sessionChatId,
        start: s.sessionStart,
        end: endTs,
        durationMs: endTs - s.sessionStart,
      });
    }
    s.sessionStart = null;
    s.sessionChatId = null;
  };

  // Phase 1: establish state as of `since` from everything at-or-before it —
  // no sessions opened yet, since a session's start is clipped to `since`.
  for (const e of all) {
    if (e.ts > since) break;
    const s = getState(e.surfaceId);
    if (e.kind === 'focus') s.chatId = e.chatId;
    else s.visible = e.visible;
  }
  for (const s of states.values()) {
    if (isActive(s)) {
      s.sessionStart = since;
      s.sessionChatId = s.chatId;
    }
  }

  // Phase 2: walk forward through (since, until], opening/closing sessions on
  // every transition into or out of "focused AND visible".
  for (const e of all) {
    if (e.ts <= since || e.ts > until) continue;
    const s = getState(e.surfaceId);
    const prevActive = isActive(s);
    const prevSessionChatId = s.sessionChatId;
    if (e.kind === 'focus') s.chatId = e.chatId;
    else s.visible = e.visible;
    const nextActive = isActive(s);
    if (prevActive && (!nextActive || s.chatId !== prevSessionChatId)) {
      closeSession(s, e.ts);
    }
    if (nextActive && s.sessionStart === null) {
      s.sessionStart = e.ts;
      s.sessionChatId = s.chatId;
    }
  }

  // Phase 3: whatever is still open at the window's end closes there.
  for (const s of states.values()) closeSession(s, until);

  return sessions;
}

export class ActivityLog {
  private readonly path: string;
  private events: StoredActivityEvent[] = [];
  private appendsSinceCompact = 0;

  constructor(
    dataDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.path = join(dataDir, 'activity.jsonl');
    if (existsSync(this.path)) {
      const raw = readFileSync(this.path, 'utf8');
      const loaded: StoredActivityEvent[] = [];
      for (const line of raw.split('\n')) {
        if (line.length === 0) continue;
        try {
          loaded.push(JSON.parse(line) as StoredActivityEvent);
        } catch {
          // Observability log, not transactional state — skip malformed lines.
        }
      }
      const cutoff = this.now() - ACTIVITY_RETENTION_MS;
      this.events = loaded.filter((e) => e.ts >= cutoff);
      this.events = this.events.slice(Math.max(0, this.events.length - ACTIVITY_MAX_STORED_EVENTS));
      if (this.events.length !== loaded.length) this.compact();
    }
  }

  private compact(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(
      tmp,
      this.events.map((e) => JSON.stringify(e)).join('\n') + (this.events.length > 0 ? '\n' : ''),
      'utf8',
    );
    renameSync(tmp, this.path);
    this.appendsSinceCompact = 0;
  }

  private append(event: StoredActivityEvent): void {
    this.events.push(event);
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, 'utf8');
    this.appendsSinceCompact += 1;
    const cutoff = event.ts - ACTIVITY_RETENTION_MS;
    const overCap = this.events.length > ACTIVITY_MAX_STORED_EVENTS;
    const hasStale = this.events.length > 0 && (this.events[0]?.ts ?? Infinity) < cutoff;
    if (overCap || hasStale) {
      this.events = this.events.filter((e) => e.ts >= cutoff);
      this.events = this.events.slice(Math.max(0, this.events.length - ACTIVITY_MAX_STORED_EVENTS));
      this.compact();
    } else if (this.appendsSinceCompact >= COMPACT_EVERY) {
      this.compact();
    }
  }

  recordFocus(surfaceId: string, chatId: string | null, ts: number = this.now()): void {
    this.append({ kind: 'focus', ts, surfaceId, chatId });
  }

  recordVisibility(surfaceId: string, visible: boolean, ts: number = this.now()): void {
    this.append({ kind: 'visibility', ts, surfaceId, visible });
  }

  /**
   * Dwell sessions for `[since, until]`, clamped to `ACTIVITY_MAX_WINDOW_MS`
   * and paged: a truncated page carries `nextSessionsCursor`; re-query with it
   * as `sessionsCursor` to continue.
   */
  querySessions(q: SessionsQuery): SessionsResult {
    const until = Math.min(q.until, this.now());
    let since = Math.min(q.since, until);
    if (until - since > ACTIVITY_MAX_WINDOW_MS) since = until - ACTIVITY_MAX_WINDOW_MS;
    const limit = Math.min(
      Math.max(Math.trunc(q.limit ?? ACTIVITY_DEFAULT_PAGE_SIZE), 1),
      ACTIVITY_MAX_PAGE_SIZE,
    );
    const focusEvents = this.events.filter(
      (e): e is StoredActivityEvent & { kind: 'focus' } => e.kind === 'focus',
    );
    const visibilityEvents = this.events.filter(
      (e): e is StoredActivityEvent & { kind: 'visibility' } => e.kind === 'visibility',
    );
    // Reconstructed over the whole window, then cut at the cursor: starting
    // the reconstruction AT the cursor would re-open a session already
    // returned on the previous page as a fresh one clipped to the cursor.
    const allSessions = computeChatSessions(focusEvents, visibilityEvents, since, until)
      .filter((s) => q.sessionsCursor === undefined || s.start >= q.sessionsCursor)
      .sort((a, b) => a.start - b.start);
    const sessionsTruncated = allSessions.length > limit;
    const chatSessions = allSessions.slice(0, limit);
    // `+1`: the next page must not re-include the last session returned.
    // This can skip a different session that starts in the SAME millisecond
    // as the cutoff — an acceptable, vanishingly rare cost for a simple cursor.
    const nextSessionsCursor = sessionsTruncated
      ? (chatSessions[chatSessions.length - 1]?.start ?? since) + 1
      : undefined;
    return {
      chatSessions,
      sessionsTruncated,
      ...(nextSessionsCursor !== undefined ? { nextSessionsCursor } : {}),
    };
  }
}
