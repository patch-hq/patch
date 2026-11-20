// Chat search REST (spec/01 § Endpoints, spec/03 § Chat search).
//
//   GET /api/chats/search?q=<query>&limit=<n>&offset=<n>&fullText=<true|false>
//                         &includeArchived=<true|false>&includeHidden=<true|false>
//
// Searches every chat on every host (archived and hidden ones only on request)
// — names, the stored first-message preview and the full text of what was said
// — from the server's chat index and its record (`chat-log-store.ts`). No host
// is asked, so a chat on an offline host is found like any other. Hits are
// ranked under the one shared ordering (`compareChatSearchHits`) and paged.
//
// Every host is still named in `hosts[]`, with how many of its chats were
// searched. Auth is exactly the other chat routes': a live surface credential.

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import {
  CHAT_SEARCH_DEFAULT_LIMIT,
  CHAT_SEARCH_MAX_DEPTH,
  CHAT_SEARCH_MAX_LIMIT,
  CHAT_SEARCH_MIN_QUERY,
  compareChatSearchHits,
  highlightRanges,
  makeSnippet,
  parseSearchQuery,
  SPECIAL_THREAD_IDS,
  type ChatSearchSection,
  type ChatSearchHit,
  type ChatSearchHostResult,
  type ChatSearchResponse,
} from '@patch/wire';
import type { Registry } from './registry.js';
import type { HostLink } from './host-link.js';
import type { ChatRegistry } from './chat-registry.js';
import type { ChatLogStore } from './chat-log-store.js';
import { matchForm } from './record-search.js';
import { requireAuth } from './folder-routes.js';

export interface ChatSearchRoutesDeps {
  logger: Logger;
  registry: Registry;
  hostLink: Pick<HostLink, 'onlineHostIds'>;
  chatRegistry: ChatRegistry;
  /** The server's record of every chat, whose message text is searched. */
  chatLogStore: Pick<ChatLogStore, 'searchMessages'>;
}

/** A query parameter as a bounded integer, or a message saying why not. */
function intParam(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number | string {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    return `${name} must be an integer ${min}..${max}`;
  }
  return n;
}

function sectionOf(
  chat: {
    chatId: string;
    status: string;
    hidden: boolean;
    pinned: boolean;
    snoozedUntil: number | null;
  },
  now: number,
): ChatSearchSection {
  if (chat.chatId === SPECIAL_THREAD_IDS.manager) return 'manager';
  if (chat.chatId === SPECIAL_THREAD_IDS.speakers) return 'channels';
  if (chat.status === 'archived') return 'archived';
  if (chat.hidden) return 'hidden';
  if (chat.status === 'active' && chat.snoozedUntil !== null && chat.snoozedUntil > now) {
    return 'snoozed';
  }
  return chat.pinned ? 'pinned' : 'folders';
}

const includesAll = (lower: string, terms: string[]): boolean =>
  terms.every((t) => lower.includes(t));

/**
 * Search the server's index and record. Returns every hit, ranked, and how
 * many chats each host had searched.
 */
export function searchRecord(
  deps: Pick<ChatSearchRoutesDeps, 'chatRegistry' | 'chatLogStore'>,
  query: string,
  opts: { fullText: boolean; includeArchived: boolean; includeHidden: boolean; now: number },
): { hits: ChatSearchHit[]; searchedByHost: Map<string, number> } {
  const terms = parseSearchQuery(query);
  const idQuery = query.trim().toLowerCase();
  const asId = /^[a-z0-9_-]+$/.test(idQuery) ? idQuery : null;
  const hits: ChatSearchHit[] = [];
  const searchedByHost = new Map<string, number>();
  // The index lists hidden chats only on their own, so they are asked for apart.
  const rows = [
    ...deps.chatRegistry.list({ includeArchived: true, includeSnoozed: true }),
    ...(opts.includeHidden ? deps.chatRegistry.list({ hiddenOnly: true }) : []),
  ];
  for (const chat of rows) {
    if (chat.status === 'deleted') continue;
    if (chat.status === 'archived' && !opts.includeArchived) continue;
    if (chat.hidden && !opts.includeHidden) continue;
    searchedByHost.set(chat.hostId, (searchedByHost.get(chat.hostId) ?? 0) + 1);
    if (terms.length === 0 && asId === null) continue;
    const nameMatch =
      chat.name !== null && terms.length > 0 && includesAll(matchForm(chat.name), terms);
    const found = opts.fullText ? deps.chatLogStore.searchMessages(chat.chatId, terms) : null;
    // The stored first-message preview stands in where the record holds no
    // match (a chat whose early entries the record never received).
    const previewMatch =
      opts.fullText &&
      found === null &&
      chat.preview !== null &&
      terms.length > 0 &&
      includesAll(matchForm(chat.preview), terms);
    // Pasting a chat's id finds that chat.
    const idMatch = asId !== null && chat.chatId.toLowerCase().includes(asId);
    if (!nameMatch && !found && !previewMatch && !idMatch) continue;
    hits.push({
      chatId: chat.chatId,
      hostId: chat.hostId,
      name: chat.name,
      preview: chat.preview,
      folder: chat.folder,
      status: chat.status,
      section: sectionOf(chat, opts.now),
      pinned: chat.pinned,
      snoozedUntil: chat.snoozedUntil,
      lastUpdated: chat.lastUpdated,
      jobId: chat.jobId,
      nameMatch,
      nameHighlights: nameMatch ? highlightRanges(chat.name!, terms) : [],
      messageMatches: found?.messageMatches ?? (previewMatch ? 1 : 0),
      snippet:
        found?.snippet ??
        (previewMatch
          ? { ...makeSnippet(chat.preview!, terms), role: 'user', seq: null, createdAt: null }
          : null),
    });
  }
  hits.sort(compareChatSearchHits);
  return { hits, searchedByHost };
}

export function registerChatSearchRoutes(app: FastifyInstance, deps: ChatSearchRoutesDeps): void {
  /** Every host this account knows: registered ones, plus any attached link. */
  function hostIds(): string[] {
    const ids = deps.registry.registeredHostIds();
    for (const linked of deps.hostLink.onlineHostIds()) {
      if (!ids.includes(linked)) ids.push(linked);
    }
    return ids;
  }

  app.get<{
    Querystring: {
      q?: string;
      limit?: string;
      offset?: string;
      fullText?: string;
      includeArchived?: string;
      includeHidden?: string;
    };
  }>('/api/chats/search', async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const query = (req.query?.q ?? '').toString().trim();
    if (query.length < CHAT_SEARCH_MIN_QUERY) {
      return reply.code(400).send({
        error: 'query_too_short',
        message: `q must be at least ${CHAT_SEARCH_MIN_QUERY} characters`,
      });
    }
    const limit = intParam(
      req.query?.limit,
      'limit',
      CHAT_SEARCH_DEFAULT_LIMIT,
      1,
      CHAT_SEARCH_MAX_LIMIT,
    );
    const offset = intParam(req.query?.offset, 'offset', 0, 0, CHAT_SEARCH_MAX_DEPTH - 1);
    if (typeof limit === 'string' || typeof offset === 'string') {
      return reply
        .code(400)
        .send({ error: 'invalid_query', message: typeof limit === 'string' ? limit : offset });
    }
    const fullTextRaw = req.query?.fullText;
    if (
      fullTextRaw !== undefined &&
      fullTextRaw !== '' &&
      !['true', 'false', '1', '0'].includes(fullTextRaw)
    ) {
      return reply
        .code(400)
        .send({ error: 'invalid_query', message: 'fullText must be true or false' });
    }
    const fullText = fullTextRaw !== 'false' && fullTextRaw !== '0';
    const archivedRaw = req.query?.includeArchived;
    if (
      archivedRaw !== undefined &&
      archivedRaw !== '' &&
      !['true', 'false', '1', '0'].includes(archivedRaw)
    ) {
      return reply
        .code(400)
        .send({ error: 'invalid_query', message: 'includeArchived must be true or false' });
    }
    const includeArchived = archivedRaw === 'true' || archivedRaw === '1';
    const hiddenRaw = req.query?.includeHidden;
    if (
      hiddenRaw !== undefined &&
      hiddenRaw !== '' &&
      !['true', 'false', '1', '0'].includes(hiddenRaw)
    ) {
      return reply
        .code(400)
        .send({ error: 'invalid_query', message: 'includeHidden must be true or false' });
    }
    const includeHidden = hiddenRaw === 'true' || hiddenRaw === '1';
    const depth = Math.min(offset + limit, CHAT_SEARCH_MAX_DEPTH);
    const { hits, searchedByHost } = searchRecord(deps, query, {
      fullText,
      includeArchived,
      includeHidden,
      now: Date.now(),
    });
    const total = hits.length;
    const end = offset + limit;
    const hosts: ChatSearchHostResult[] = hostIds().map((hostId) => ({
      hostId,
      hostName: deps.registry.hostName(hostId) ?? null,
      state: 'searched',
      searchedChats: searchedByHost.get(hostId) ?? 0,
    }));
    const body: ChatSearchResponse = {
      query,
      hits: hits.slice(offset, depth),
      total,
      nextOffset: end < Math.min(total, CHAT_SEARCH_MAX_DEPTH) ? end : null,
      hosts,
    };
    return reply.code(200).send(body);
  });
}
