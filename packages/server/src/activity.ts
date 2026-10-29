// The user's own messages (spec/06 § Cross-chat toolset — `patch_activity`).
//
// There is no activity store: a user message is a `chat.message` event with
// role 'user' in the chat's own history log, and those logs live on the host
// that owns each chat. So `patch_activity` is a read-through — the server asks
// every online host for the user messages in its own logs for the window,
// merges the answers, and joins them against the chat mirror for name/host/
// folder. NO FALLBACK: a host that is offline or does not answer fails the
// call, because an answer missing one host's messages would look complete.
//
// Not every `role: 'user'` row is a person typing: a job's fire, a hook/goal
// resubmit, or the host starting a turn itself (self-wake, Manager sweep, a
// delegate relay, the todo list advancing) all land that way too. Each host
// already reads its own `kind` off the turn's own flags (`userMessages.ts`);
// this module only carries it through the join untouched — see
// `ActivityMessageKind` for what each value means.

import { randomUUID } from 'node:crypto';
import type {
  ActivityChatSession,
  ActivityMessage,
  PatchActivityReadResponseEvent,
} from '@patch/wire';
import type { ActivityLog } from './activity-log.js';
import type { ChatRegistry } from './chat-registry.js';
import type { HostLink } from './host-link.js';

/** How far back a single `patch_activity` call may reach. Declared in code per spec/06. */
export const ACTIVITY_MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const ACTIVITY_DEFAULT_PAGE_SIZE = 200;
export const ACTIVITY_MAX_PAGE_SIZE = 500;
/** How long one host has to answer one read attempt. */
export const ACTIVITY_READ_TIMEOUT_MS = 15_000;
/**
 * Attempts per host before the whole call fails. A request frame can be lost
 * to a link flap (buffered, then answered for a requestId nobody waits on) and
 * the host re-reads its log in well under a timeout, so one silent attempt is
 * retried; a host silent for every attempt still fails the call.
 */
export const ACTIVITY_READ_ATTEMPTS = 2;

const READ_SURFACE_ID = 'activity-read';

export interface ActivityQuery {
  since: number;
  until: number;
  /** Resume point from a previously truncated page. */
  messagesCursor?: number;
  /**
   * Also return the chat dwell sessions (recorded by the server, not read
   * from a host). Opt-in so a caller that never asks gets the messages-only
   * result it always did.
   */
  includeSessions?: boolean;
  /** Resume point from a truncated sessions page; implies `includeSessions`. */
  sessionsCursor?: number;
  limit?: number;
}

export interface ActivityResult {
  messages: ActivityMessage[];
  messagesTruncated: boolean;
  nextMessagesCursor?: number;
  /** Present only when sessions were asked for. */
  chatSessions?: ActivityChatSession[];
  sessionsTruncated?: boolean;
  nextSessionsCursor?: number;
}

export interface ActivityReader {
  query(q: ActivityQuery): Promise<ActivityResult>;
  /** Stop listening and fail anything still waiting. */
  close(): void;
}

export function createActivityReader(deps: {
  hostLink: HostLink;
  chatRegistry: ChatRegistry;
  /** Where dwell sessions are recorded; without one, asking for them fails. */
  log?: ActivityLog;
  now?: () => number;
  readTimeoutMs?: number;
}): ActivityReader {
  const readTimeoutMs = deps.readTimeoutMs ?? ACTIVITY_READ_TIMEOUT_MS;
  const { hostLink, chatRegistry, log } = deps;
  const now = deps.now ?? Date.now;
  const waiting = new Map<
    string,
    { resolve: (e: PatchActivityReadResponseEvent) => void; reject: (err: Error) => void }
  >();

  const unsubscribe = hostLink.onEvent((event) => {
    if (event.type !== 'patch.activity.read.response') return;
    const w = waiting.get(event.requestId);
    if (w) w.resolve(event);
  });

  const readHostOnce = (
    hostId: string,
    since: number,
    until: number,
    limit: number,
  ): Promise<PatchActivityReadResponseEvent> =>
    new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        waiting.delete(requestId);
        reject(
          new Error(
            `patch_activity: host ${hostId} did not answer within ${readTimeoutMs / 1000}s`,
          ),
        );
      }, readTimeoutMs);
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
        type: 'patch.activity.read.request',
        requestId,
        since,
        until,
        limit,
      });
    });

  const readHost = async (
    hostId: string,
    since: number,
    until: number,
    limit: number,
  ): Promise<PatchActivityReadResponseEvent> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await readHostOnce(hostId, since, until, limit);
      } catch (err) {
        if (attempt >= ACTIVITY_READ_ATTEMPTS || !String(err).includes('did not answer')) throw err;
      }
    }
  };

  /** Dwell sessions joined against the chat mirror; a chat it no longer knows is dropped. */
  const sessionsFor = (
    q: ActivityQuery,
  ): Pick<ActivityResult, 'chatSessions' | 'sessionsTruncated' | 'nextSessionsCursor'> => {
    const r = log!.querySessions({
      since: q.since,
      until: q.until,
      ...(q.sessionsCursor !== undefined ? { sessionsCursor: q.sessionsCursor } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
    });
    const chatSessions: ActivityChatSession[] = [];
    for (const s of r.chatSessions) {
      const chat = chatRegistry.get(s.chatId);
      if (!chat) continue;
      chatSessions.push({
        chatId: s.chatId,
        chatName: chat.name,
        hostId: chat.hostId,
        folder: chat.folder,
        start: s.start,
        end: s.end,
        durationMs: s.durationMs,
      });
    }
    return {
      chatSessions,
      sessionsTruncated: r.sessionsTruncated,
      ...(r.nextSessionsCursor !== undefined ? { nextSessionsCursor: r.nextSessionsCursor } : {}),
    };
  };

  return {
    async query(q) {
      const wantSessions = q.includeSessions === true || q.sessionsCursor !== undefined;
      if (wantSessions && !log) {
        throw new Error('patch_activity: chat sessions are not recorded on this server');
      }
      const until = Math.min(q.until, now());
      let since = Math.min(q.since, until);
      if (until - since > ACTIVITY_MAX_WINDOW_MS) since = until - ACTIVITY_MAX_WINDOW_MS;
      const limit = Math.min(
        Math.max(Math.trunc(q.limit ?? ACTIVITY_DEFAULT_PAGE_SIZE), 1),
        ACTIVITY_MAX_PAGE_SIZE,
      );
      const from = q.messagesCursor !== undefined ? Math.max(q.messagesCursor, since) : since;

      const hosts = hostLink.onlineHostIds();
      // Each host returns its oldest `limit + 1` — enough to tell whether
      // the merged page is truncated without any host sending its whole log.
      const answers = await Promise.all(hosts.map((h) => readHost(h, from, until, limit + 1)));
      const all = answers.flatMap((a) => a.messages).sort((a, b) => a.ts - b.ts);
      const truncated = all.length > limit;
      let page = all.slice(0, limit);
      // The cursor is a timestamp and hosts read `ts >= since`, so a page must
      // not end inside a run of equal timestamps: what follows the cut would
      // be skipped. End the page before the run and resume AT it instead.
      let nextMessagesCursor: number | undefined;
      if (truncated) {
        const runTs = all[limit]!.ts;
        const runStart = page.findIndex((m) => m.ts === runTs);
        if (runStart > 0) {
          page = page.slice(0, runStart);
          nextMessagesCursor = runTs;
        } else if (runStart === 0) {
          // The run fills the page, so ending before it would never move on:
          // read that instant in full and return all of it.
          const run = await Promise.all(
            hosts.map((h) => readHost(h, runTs, runTs, Number.MAX_SAFE_INTEGER)),
          );
          page = run.flatMap((a) => a.messages);
          nextMessagesCursor = runTs + 1;
        } else {
          // `+1`: the next page must not re-include the last message returned.
          nextMessagesCursor = page[page.length - 1]!.ts + 1;
        }
      }

      const messages: ActivityMessage[] = [];
      for (const m of page) {
        const chat = chatRegistry.get(m.chatId);
        // A chat the mirror no longer knows has no host to attribute it to.
        if (!chat) continue;
        messages.push({
          chatId: m.chatId,
          chatName: chat.name,
          hostId: chat.hostId,
          folder: chat.folder,
          text: m.text,
          ts: m.ts,
          ...(m.kind !== undefined ? { kind: m.kind } : {}),
        });
      }
      const sessions = wantSessions ? sessionsFor(q) : undefined;
      return {
        messages,
        messagesTruncated: truncated,
        ...(nextMessagesCursor !== undefined ? { nextMessagesCursor } : {}),
        ...(sessions ?? {}),
      };
    },
    close() {
      unsubscribe();
      for (const w of [...waiting.values()]) w.reject(new Error('patch_activity: server closing'));
    },
  };
}
