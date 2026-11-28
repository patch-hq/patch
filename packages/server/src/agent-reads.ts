// `patch_peek` and `patch_history`, answered by the server (spec/03 § Cross-chat
// tools, spec/06 § Cross-chat toolset). Both read the server's record of the
// chat (`chat-log-store.ts`) and the status the server derives for it
// (`chat-status.ts`), never a host, so a chat whose host is offline reads the
// same as any other.

import type { ChatErrorCode, WireEvent } from '@patch/wire';
import type { ChatLogStore, TrackAsk } from './chat-log-store.js';
import type { ChatRegistry } from './chat-registry.js';

export const PEEK_DEFAULT_LIMIT = 50;
export const READ_HARD_CAP = 200;
export const HISTORY_DEFAULT_LIMIT = 50;
/** How many of a chat's latest messages `chat_state.lastMessages` carries. */
export const LAST_MESSAGES = 20;

export interface AgentReadDeps {
  chatRegistry: ChatRegistry;
  chatLogStore: ChatLogStore;
  isHostOnline: (hostId: string) => boolean;
}

export type ReadOutcome<T> =
  | { ok: true; result: T }
  | { ok: false; error: { code: ChatErrorCode; message: string } };

const notFound = (chatId: string): ReadOutcome<never> => ({
  ok: false,
  error: { code: 'chat_not_found', message: `no such chat: ${chatId}` },
});

/** The track a read is laid out on: the chat's active branch. */
function trackOf(row: NonNullable<ReturnType<ChatRegistry['get']>>): {
  track?: TrackAsk;
} {
  const branchId = row.activeBranchId ?? undefined;
  return branchId !== undefined ? { track: { branches: row.branches, branchId } } : {};
}

const clamp = (limit: number | undefined, fallback: number): number =>
  Math.min(Math.max(Math.trunc(limit ?? fallback), 1), READ_HARD_CAP);

/**
 * A `patch_agent` subagent is never in the registry (spec/02 § Native subagent
 * dispatch) but its record is kept against its parent. It is readable by
 * anyone who could read the parent: the parent row must be a known chat.
 */
function subagentParent(
  deps: AgentReadDeps,
  chatId: string,
): NonNullable<ReturnType<ChatRegistry['get']>> | undefined {
  const parentId = deps.chatLogStore.parentOf(chatId);
  return parentId === undefined ? undefined : deps.chatRegistry.get(parentId);
}

function peekSubagent(
  deps: AgentReadDeps,
  chatId: string,
  limit?: number,
): ReturnType<typeof peekChat> {
  const parent = subagentParent(deps, chatId);
  if (!parent) return notFound(chatId);
  const page = deps.chatLogStore.page(chatId, { limit: clamp(limit, PEEK_DEFAULT_LIMIT) });
  const track = deps.chatLogStore.entries(chatId, -1);
  const lastMessages: { role: string; content: string; seq: number; ts: number | null }[] = [];
  for (let i = track.length - 1; i >= 0 && lastMessages.length < LAST_MESSAGES; i--) {
    const e = track[i]!;
    if (e.type !== 'chat.message' || typeof e.content !== 'string' || e.content === '') continue;
    if (e.role !== 'user' && e.role !== 'assistant') continue;
    lastMessages.push({
      role: e.role,
      content: e.content,
      seq: e.seq,
      ts: typeof e.createdAt === 'number' ? e.createdAt : null,
    });
  }
  lastMessages.reverse();
  const chat_state: Record<string, unknown> = {
    chatId,
    subagentOf: parent.chatId,
    hostId: parent.hostId,
    hostOnline: deps.isHostOnline(parent.hostId),
    folder: parent.folder,
    lastMessages,
    lastMessage: [...lastMessages].reverse().find((m) => m.role === 'assistant')?.content,
    eventCount: page.through + 1,
  };
  return {
    ok: true,
    result: stripBinaryPayloads({ chat_state, events: page.entries, truncated: page.more }),
  };
}

export function peekChat(
  deps: AgentReadDeps,
  chatId: string,
  limit?: number,
): ReadOutcome<{ chat_state: Record<string, unknown>; events: unknown[]; truncated: boolean }> {
  const row = deps.chatRegistry.get(chatId);
  if (!row) return peekSubagent(deps, chatId, limit);
  const page = deps.chatLogStore.page(chatId, {
    limit: clamp(limit, PEEK_DEFAULT_LIMIT),
    ...trackOf(row),
  });
  // The chat's latest user and assistant messages, from the whole track rather
  // than the slice returned, so an agent sees at a glance what it has been
  // saying even when `events` is a page of tool calls.
  const lastMessages: { role: string; content: string; seq: number; ts: number | null }[] = [];
  const track = deps.chatLogStore.entries(chatId, -1, trackOf(row).track);
  for (let i = track.length - 1; i >= 0 && lastMessages.length < LAST_MESSAGES; i--) {
    const e = track[i]!;
    if (e.type !== 'chat.message' || typeof e.content !== 'string' || e.content === '') continue;
    if (e.role !== 'user' && e.role !== 'assistant') continue;
    lastMessages.push({
      role: e.role,
      content: e.content,
      seq: e.seq,
      ts: typeof e.createdAt === 'number' ? e.createdAt : null,
    });
  }
  lastMessages.reverse();
  const lastMessage = [...lastMessages].reverse().find((m) => m.role === 'assistant')?.content;
  const chat_state: Record<string, unknown> = {
    chatId: row.chatId,
    hostId: row.hostId,
    hostOnline: deps.isHostOnline(row.hostId),
    name: row.name,
    folder: row.folder,
    chatStatus: row.chatStatus ?? null,
    status: row.status,
    // Where the chat says it stands: its one-line status, goal and to-dos.
    statusSummary: row.statusSummary,
    goal: row.goal,
    todos: row.todos,
    pinned: row.pinned,
    pinnedAt: row.pinnedAt,
    snoozedUntil: row.snoozedUntil,
    model: row.model,
    lastUpdated: row.lastUpdated,
    lastMessages,
    // The latest thing the chat's agent said.
    lastMessage,
    lastError: row.lastError,
    // How much the chat has ever said: true whether or not any of it is in `events`.
    eventCount: page.through + 1,
  };
  return {
    ok: true,
    result: stripBinaryPayloads({ chat_state, events: page.entries, truncated: page.more }),
  };
}

export function chatHistory(
  deps: AgentReadDeps,
  chatId: string,
  fromSeq?: number,
  limit?: number,
): ReadOutcome<{ events: WireEvent[]; nextFromSeq?: number }> {
  const row = deps.chatRegistry.get(chatId);
  if (!row && !subagentParent(deps, chatId)) return notFound(chatId);
  const from = fromSeq ?? 0;
  const page = deps.chatLogStore.page(chatId, {
    after: from - 1,
    limit: clamp(limit, HISTORY_DEFAULT_LIMIT),
    ...(row ? trackOf(row) : {}),
  });
  const result: { events: WireEvent[]; nextFromSeq?: number } = { events: page.entries };
  if (page.more) {
    let last = from - 1;
    for (const e of page.entries) {
      const seq = (e as { seq?: unknown }).seq;
      if (typeof seq === 'number' && seq > last) last = seq;
    }
    result.nextFromSeq = last + 1;
  }
  return { ok: true, result: stripBinaryPayloads(result) };
}

const MAX_STRING = 8_000;

/**
 * Peek/history are read by agents, so an inlined image (a screenshot tool
 * result is base64 in the wire event) costs megabytes of context for nothing.
 * Replace base64 image sources with a size marker and truncate any other
 * oversized string. Returns a copy; the record is untouched.
 */
export function stripBinaryPayloads<T>(value: T): T {
  return strip(value) as T;
}

function strip(v: unknown): unknown {
  if (typeof v === 'string') {
    return v.length > MAX_STRING
      ? `${v.slice(0, MAX_STRING)}…[truncated ${v.length - MAX_STRING} chars]`
      : v;
  }
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const src = o['source'] as { type?: unknown; data?: unknown; media_type?: unknown } | undefined;
    if (o['type'] === 'image' && src && src.type === 'base64' && typeof src.data === 'string') {
      const media = typeof src.media_type === 'string' ? src.media_type : 'image';
      return { type: 'image', omitted: `[${media} omitted, ${src.data.length} base64 chars]` };
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) out[k] = strip(val);
    return out;
  }
  return v;
}
