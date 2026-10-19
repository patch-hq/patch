// Search across every chat on the account (spec/06 § Cross-chat toolset —
// `patch_search_chats`). Answered from what the server already holds: the chat
// mirror (name, folder, summary) and the transcripts that have passed through it.
// A chat the server holds no transcript for is searched by metadata only, and
// the answer says how many those were, so a miss is never read as "not there".

import type { ChatRegistry } from './chat-registry.js';
import type { ChatLogStore } from './chat-log-store.js';

export const SEARCH_DEFAULT_LIMIT = 20;
const EXCERPTS_PER_CHAT = 3;
const EXCERPT_RADIUS = 80;

export type SearchField = 'name' | 'folder' | 'summary' | 'messages';

export interface ChatSearchResult {
  chatId: string;
  hostId: string;
  name: string | null;
  folder: string;
  status: 'active' | 'archived' | 'errored' | 'deleted';
  lastUpdated: number;
  matchedIn: SearchField[];
  excerpts: Array<{ seq: number; role: string; text: string }>;
}

export interface ChatSearchAnswer {
  results: ChatSearchResult[];
  truncated: boolean;
  chatsWithoutLog: number;
}

function excerptOf(text: string, at: number, len: number): string {
  const start = Math.max(0, at - EXCERPT_RADIUS);
  const end = Math.min(text.length, at + len + EXCERPT_RADIUS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

export function searchChats(
  deps: { chatRegistry: ChatRegistry; chatLogStore: ChatLogStore },
  query: string,
  limit: number = SEARCH_DEFAULT_LIMIT,
): ChatSearchAnswer {
  const needle = query.toLowerCase();
  const hits: Array<ChatSearchResult & { score: number }> = [];
  let chatsWithoutLog = 0;
  for (const chat of deps.chatRegistry.list({ includeArchived: true })) {
    const matchedIn: SearchField[] = [];
    if (chat.name?.toLowerCase().includes(needle)) matchedIn.push('name');
    if (chat.folder.toLowerCase().includes(needle)) matchedIn.push('folder');
    if (chat.statusSummary?.toLowerCase().includes(needle)) matchedIn.push('summary');
    const excerpts: ChatSearchResult['excerpts'] = [];
    if (!deps.chatLogStore.has(chat.chatId)) {
      chatsWithoutLog += 1;
    } else {
      let messageHits = 0;
      for (const ev of deps.chatLogStore.read(chat.chatId, -1)) {
        if (ev.type !== 'chat.message') continue;
        const at = ev.content.toLowerCase().indexOf(needle);
        if (at < 0) continue;
        messageHits += 1;
        if (excerpts.length < EXCERPTS_PER_CHAT) {
          excerpts.push({
            seq: ev.seq,
            role: ev.role,
            text: excerptOf(ev.content, at, needle.length),
          });
        }
      }
      if (messageHits > 0) matchedIn.push('messages');
    }
    if (matchedIn.length === 0) continue;
    hits.push({
      chatId: chat.chatId,
      hostId: chat.hostId,
      name: chat.name,
      folder: chat.folder,
      status: chat.status,
      lastUpdated: chat.lastUpdated,
      matchedIn,
      excerpts,
      // A title match outranks a body match; recency breaks ties.
      score:
        (matchedIn.includes('name') ? 4 : 0) +
        (matchedIn.includes('summary') ? 2 : 0) +
        (matchedIn.includes('folder') ? 1 : 0),
    });
  }
  hits.sort((a, b) => b.score - a.score || b.lastUpdated - a.lastUpdated);
  const results = hits.slice(0, limit).map(({ score: _s, ...r }) => r);
  return { results, truncated: hits.length > limit, chatsWithoutLog };
}
