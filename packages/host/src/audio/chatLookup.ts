// Finding and reading other chats from a voice call (spec/07 § The voice agent
// and the chat's agent). One implementation for every call, on every provider:
// the listing and the reads come from the Patch server, so a chat on another
// host is found and read like one on this host, and hidden, snoozed and
// archived chats are included and labelled.

import { stripVoiceTag } from '../chatRunner.js';

/** The chat a call must be on to be a Manager call. */
export const MANAGER_CHAT_ID = 'thread_manager';

export function isManagerCall(chatId: string): boolean {
  return chatId === MANAGER_CHAT_ID;
}

/** A name that matches no chat, or more than one: the voice asks the user, nothing failed. */
export class ChatLookupError extends Error {}

/** One chat as a voice call sees it in a listing. */
export interface ChatEntry {
  chatId: string;
  name: string | null;
  folder: string;
  status: string;
  hidden: boolean;
  snoozed: boolean;
  /** The chat's status as the server decided it (spec/12 § Chat status). */
  chatStatus?: string;
  lastUpdated?: number;
}

export const LIST_LIMIT = 8;

/** The server's status in words the voice can say. */
function statusWords(state: string | undefined): string {
  switch (state) {
    case 'running':
      return 'working';
    case 'waiting_for_user':
      return 'waiting for you';
    case 'failed':
      return 'stopped on an error';
    case 'interrupted':
      return 'interrupted';
    case 'paused':
      return 'paused on a limit';
    case 'waiting_for_sign_in':
      return 'waiting for sign-in';
    case 'host_offline':
      return 'its host is offline';
    case 'host_restarting':
      return 'its host is restarting';
    case 'queued_offline':
      return 'queued for its offline host';
    case 'idle':
      return 'idle';
    default:
      return 'status unknown';
  }
}

export function displayName(c: ChatEntry): string {
  return c.name?.trim() || c.folder.split('/').filter(Boolean).pop() || c.chatId;
}

function ago(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
}

/** The chats a call may name: not the Manager itself, nothing deleted (hidden, snoozed and archived ones are named too). */
export function nameableChats(all: ChatEntry[]): ChatEntry[] {
  return all.filter((c) => c.chatId !== MANAGER_CHAT_ID && c.status !== 'deleted');
}

/** Where a chat is kept, for the voice to say: nothing for an active chat. */
function shelf(c: ChatEntry): 'archived' | 'hidden' | 'snoozed' | null {
  if (c.status === 'archived') return 'archived';
  if (c.hidden) return 'hidden';
  if (c.snoozed) return 'snoozed';
  return null;
}

/** Of several chats a name fits, the one that is active, when only one is. */
function onlyCurrent(matches: ChatEntry[]): ChatEntry | undefined {
  const current = matches.filter((c) => shelf(c) === null);
  return current.length === 1 ? current[0] : undefined;
}

/**
 * The one chat a call means by an id or a spoken name (spec/07 § A call to the
 * Manager, § A call stays on its chat): an id or an exact name wins, otherwise
 * the words must pick out one chat. A name that fits none or several is a
 * {@link ChatLookupError} naming the choices, for the voice to ask about.
 */
export function resolveChat(listing: ChatEntry[], chat: string): ChatEntry {
  const all = nameableChats(listing);
  const wanted = chat.trim();
  if (wanted === '') throw new ChatLookupError('Say which chat.');
  const byId = all.find((c) => c.chatId === wanted);
  if (byId) return byId;
  const lower = wanted.toLowerCase();
  const exact = all.filter((c) => displayName(c).toLowerCase() === lower);
  if (exact.length === 1) return exact[0]!;
  const exactCurrent = onlyCurrent(exact);
  if (exactCurrent) return exactCurrent;
  const terms = words(wanted);
  const partial =
    exact.length > 1
      ? exact
      : all.filter((c) => {
          const hay = words(`${displayName(c)} ${c.folder}`);
          return terms.every((t) => hay.some((w) => w.startsWith(t)));
        });
  if (partial.length === 1) return partial[0]!;
  const partialCurrent = onlyCurrent(partial);
  if (partialCurrent) return partialCurrent;
  if (partial.length === 0) {
    throw new ChatLookupError(`No chat matches "${wanted}".`);
  }
  throw new ChatLookupError(
    `Several chats match "${wanted}": ${partial
      .slice(0, LIST_LIMIT)
      .map((c) => `"${displayName(c)}"${shelf(c) ? ` (${shelf(c)})` : ''}`)
      .join(', ')}. Ask the user which one.`,
  );
}

/** Where a chat stands, from `patch_peek`'s `chat_state` (built by the server's agent-reads). */
interface ChatDetail {
  status: string | null;
  goal: string | null;
  openTodos: string[];
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
}

function chatDetail(chatState: unknown): ChatDetail {
  if (chatState === null || typeof chatState !== 'object') {
    throw new Error('The Patch server sent no state for the chat.');
  }
  const st = chatState as Record<string, unknown>;
  const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
  const todos = Array.isArray(st['todos']) ? (st['todos'] as Array<Record<string, unknown>>) : [];
  const messages = Array.isArray(st['lastMessages'])
    ? (st['lastMessages'] as Array<Record<string, unknown>>)
    : [];
  return {
    status: text(st['statusSummary']),
    goal: text(st['goal']),
    openTodos: todos.flatMap((t) =>
      t['status'] !== 'completed' && typeof t['text'] === 'string' ? [t['text']] : [],
    ),
    messages: messages.flatMap((m) =>
      (m['role'] === 'user' || m['role'] === 'assistant') && typeof m['content'] === 'string'
        ? [{ role: m['role'], text: m['content'] }]
        : [],
    ),
  };
}

export interface ChatLookupDeps {
  /** Every chat the account has, on every host, hidden, snoozed and archived included, from the server (`patch_list_chats`). */
  listChats(callerChatId: string): Promise<ChatEntry[]>;
  /** A chat as the server's record holds it, on any host (`patch_peek`'s `chat_state`), read on behalf of `callerChatId`. */
  peekChat(chatId: string, callerChatId: string): Promise<unknown>;
  now?: () => number;
}

export interface ChatLookup {
  findChats(query: string, callerChatId: string): Promise<string>;
  /** Where `chat` (a name or id) stands. `callerChatId` is the chat the call is on; the server reads on its behalf. */
  chatStatus(chat: string, callerChatId: string): Promise<string>;
  /** The one chat a name or id means; rejects with {@link ChatLookupError} for none or several. */
  resolve(chat: string, callerChatId: string): Promise<ChatEntry>;
}

export function createChatLookup(deps: ChatLookupDeps): ChatLookup {
  const now = deps.now ?? Date.now;

  const line = (c: ChatEntry): string => {
    const kept = shelf(c);
    const parts = kept ? [kept] : [statusWords(c.chatStatus)];
    if (c.lastUpdated !== undefined) parts.push(`last active ${ago(now() - c.lastUpdated)}`);
    return `"${displayName(c)}" (id ${c.chatId}) — ${parts.join(', ')}`;
  };

  const resolve = async (chat: string, callerChatId: string): Promise<ChatEntry> =>
    resolveChat(await deps.listChats(callerChatId), chat);

  return {
    resolve,

    async findChats(query, callerChatId) {
      const all = nameableChats(await deps.listChats(callerChatId));
      const terms = words(query);
      const scored = all
        .map((c) => {
          const hay = words(`${displayName(c)} ${c.folder}`);
          return { c, score: terms.filter((t) => hay.some((w) => w.startsWith(t))).length };
        })
        .filter((x) => terms.length === 0 || x.score > 0)
        .sort((a, b) => b.score - a.score || (b.c.lastUpdated ?? 0) - (a.c.lastUpdated ?? 0));
      if (scored.length === 0) return `No chat matches "${query}".`;
      return scored
        .slice(0, LIST_LIMIT)
        .map((x) => line(x.c))
        .join('\n');
    },

    async chatStatus(chat, callerChatId) {
      const target = await resolve(chat, callerChatId);
      const d = chatDetail(await deps.peekChat(target.chatId, callerChatId));
      const out = [line(target)];
      if (d.status) out.push(`Where it stands: ${d.status}`);
      if (d.goal) out.push(`Goal: ${d.goal}`);
      if (d.openTodos.length > 0) out.push(`Still to do: ${d.openTodos.slice(0, 6).join('; ')}`);
      const recent = d.messages.slice(-4).map((m) => {
        const flat = stripVoiceTag(m.text).replace(/\s+/g, ' ').trim();
        const short = flat.length > 300 ? `${flat.slice(0, 299).trimEnd()}…` : flat;
        return `${m.role === 'user' ? 'User' : 'Agent'}: ${short}`;
      });
      if (recent.length > 0) out.push(`Last messages:\n${recent.join('\n')}`);
      return out.join('\n');
    },
  };
}
