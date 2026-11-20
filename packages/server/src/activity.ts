// The user's own messages (spec/06 § Cross-chat toolset — `patch_activity`).
//
// There is no activity store: a user message is a `chat.message` event with
// role 'user' in the chat's record, and the server holds every chat's record
// (`chat-log-store.ts`). So `patch_activity` reads the record and joins it
// against the chat index for name/host/folder. No host is asked, so a chat on
// an offline host is answered for like any other.
//
// Not every `role: 'user'` row is a person typing; each row's `kind` says what
// produced it (`record-activity.ts`, `ActivityMessageKind`).

import type { ActivityChatSession, ActivityMessage } from '@patch/wire';
import type { ActivityLog } from './activity-log.js';
import type { ChatLogStore } from './chat-log-store.js';
import type { ChatRegistry } from './chat-registry.js';

/** How far back a single `patch_activity` call may reach. Declared in code per spec/06. */
export const ACTIVITY_MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const ACTIVITY_DEFAULT_PAGE_SIZE = 200;
export const ACTIVITY_MAX_PAGE_SIZE = 500;

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
}

export function createActivityReader(deps: {
  chatLogStore: ChatLogStore;
  chatRegistry: ChatRegistry;
  /** Where dwell sessions are recorded; without one, asking for them fails. */
  log?: ActivityLog;
  now?: () => number;
}): ActivityReader {
  const { chatLogStore, chatRegistry, log } = deps;
  const now = deps.now ?? Date.now;

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

      const all = chatLogStore.userMessages(from, until);
      const truncated = all.length > limit;
      let page = all.slice(0, limit);
      // The cursor is a timestamp and the read takes `ts >= since`, so a page must
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
          page = all.filter((m) => m.ts === runTs);
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
  };
}
