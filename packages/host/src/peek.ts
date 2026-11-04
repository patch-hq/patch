// The `patch_peek` result shape (spec/06 § Cross-chat toolset), factored out
// so the LOCAL endpoint (control.ts `/internal/peek/:id`) and a host
// answering ANOTHER host's cross-host relay (index.ts, on an inbound
// `patch.peek.request`) build the exact same object rather than two
// hand-maintained copies drifting apart.

import type { Daemon } from './chatRunner.js';

export interface PeekResult {
  chat_state: {
    chatId: string;
    name: string | null | undefined;
    folder: string;
    activity: unknown;
    status: unknown;
    pinned: unknown;
    pinnedAt: unknown;
    lastMessages: unknown;
    lastUpdated: number;
    lastMessage: string | undefined;
    lastError: unknown;
    eventCount: number;
    hasClaudeSession: boolean;
  };
  events: unknown[];
  truncated: boolean;
}

/** `undefined` iff `chatId` is not one of THIS host's own chats. */
export function buildPeekResult(
  daemon: Daemon,
  chatId: string,
  limit: number,
): PeekResult | undefined {
  const state = daemon.chatState.get(chatId);
  if (!state) return undefined;
  const lastMsg =
    state.lastMessages.length > 0
      ? state.lastMessages[state.lastMessages.length - 1]?.content
      : undefined;
  const chat_state: PeekResult['chat_state'] = {
    chatId: state.chatId,
    name: state.name,
    folder: state.folder,
    activity: state.activity,
    status: state.status,
    pinned: state.pinned,
    pinnedAt: state.pinnedAt,
    lastMessages: state.lastMessages,
    lastUpdated: state.lastUpdated,
    lastMessage: lastMsg,
    lastError: state.lastError,
    eventCount: state.nextSeq,
    hasClaudeSession: state.claudeSessionId !== undefined && state.claudeSessionId !== '',
  };
  const { events, truncated } = daemon.getRecentEvents(state.chatId, limit);
  return { chat_state, events, truncated };
}

const MAX_STRING = 8_000;

/**
 * Peek/history are read by agents, so an inlined image (a screenshot tool
 * result is base64 in the wire event) costs megabytes of context for nothing.
 * Replace base64 image sources with a size marker and truncate any other
 * oversized string. Returns a copy; the stored events are untouched.
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
