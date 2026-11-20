// Chat search (spec/02 § Chat search, spec/03 § Chat search).
//
// Searches every chat on this host — its name, and the text of every user and
// assistant message in its log — and answers with ranked hits carrying a
// highlighted snippet and the matched message's seq for jump-to.
//
// WHERE THE TEXT COMES FROM. Each chat's own log (`~/.patch/chats/<id>/
// events.jsonl`, spec/04 § History), the same record every surface draws from;
// a provider's session files are never read (spec/04 § History). The index is
// a DERIVED, IN-MEMORY cache of the logs, never written anywhere. It is built
// once in the background when the host starts and then kept current
// incrementally: every search stats each chat's log and reads only the bytes
// appended since the last look. A restart simply rebuilds it.
//
// WHY NOT A SCAN PER QUERY, OR SQLite FTS. Chat histories run to gigabytes, of
// which the searchable text — user and assistant messages — is a few percent;
// the rest is tool output, tool inputs and thinking. A per-query scan re-reads
// all of it (seconds, and the raw bytes are JSON-escaped, so they cannot even
// be matched case-insensitively as-is). An FTS index would be a second,
// persisted copy of every message plus a native dependency on every host.
// Holding the message text in memory answers a query in tens of milliseconds
// and stores nothing.
//
// WHAT IS SEARCHED. User and assistant message text exactly as the record
// holds it, on the chat's current track. Tool calls and their output are NOT
// searched: they are most of the bytes and would drown every query in file
// dumps and command output — a search for a word finds every chat that ever
// `cat`-ed a file containing it.

import { closeSync, openSync, readSync, statSync } from 'node:fs';
import {
  compareChatSearchHits,
  highlightRanges,
  makeSnippet,
  parseSearchQuery,
  SPECIAL_THREAD_IDS,
  type ChatSearchHit,
  type ChatSearchSection,
  type ChatStatus,
  type TrackSegment,
  type WireEvent,
} from '@patch/wire';
export { highlightRanges, makeSnippet };

/** The fields of a chat the search reads — a subset of `ChatState`. */
export interface SearchableChat {
  chatId: string;
  name: string | null;
  preview: string | null;
  folder: string;
  status: ChatStatus;
  pinned: boolean;
  snoozedUntil: number | null;
  /** spec/04 § Hidden — drawn in the Hidden section while active. */
  hidden: boolean;
  lastUpdated: number;
  /** The ACTIVE track's session (spec/04 § Branching); absent before the first turn. */
  claudeSessionId: string | undefined;
  /**
   * The chat's current track (spec/04 § Branching): only its messages are
   * searched. Absent for a chat that has never branched, whose log is one track.
   */
  track?: TrackSegment[];
}

export interface ChatSearchIndexOptions {
  /** A chat's own log (`~/.patch/chats/<id>/events.jsonl`). */
  logPath: (chatId: string) => string;
  now: () => number;
  /** A log line that is not valid JSON — skipped, and reported here. */
  onCorruptLine?: (info: { path: string; message: string }) => void;
}

interface IndexedMessage {
  role: 'user' | 'assistant';
  text: string;
  lower: string;
  branchId: string;
  seq: number;
  createdAt: number | null;
}

interface ChatEntry {
  path: string;
  /** Bytes consumed — always the end of a complete line. */
  offset: number;
  /** One per branch and seq: a rewritten entry replaces the one it supersedes. */
  messages: Map<string, IndexedMessage>;
}

export interface ChatSearchResult {
  hits: ChatSearchHit[];
  total: number;
  searchedChats: number;
  transcriptsMissing: number;
}

/** Characters of context either side of the match in a snippet. */

/**
 * Only a log line that holds a message is worth parsing. A record's envelope
 * (version, seq, time, branch, turn, native id) sits ahead of the event, so the
 * event type is always near the start; checking only the head keeps the scan
 * off the tool output a single line can carry.
 */
const MESSAGE_MARKER = Buffer.from('"type":"chat.message"');
const HEAD_BYTES = 1024;
/** Read logs in slices, so one huge file never needs one huge buffer. */
const READ_CHUNK = 8 * 1024 * 1024;

function holdsMessage(line: Buffer): boolean {
  const head = line.length > HEAD_BYTES ? line.subarray(0, HEAD_BYTES) : line;
  return head.indexOf(MESSAGE_MARKER) >= 0;
}

/** Query → distinct lowercase terms; a "quoted run" is one exact-phrase term. */
export function queryTerms(query: string): string[] {
  return parseSearchQuery(query);
}

/** Lowercased with whitespace runs collapsed, so a phrase matches across a line break. */
function matchForm(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ');
}

function includesAll(lower: string, terms: string[]): boolean {
  for (const t of terms) if (!lower.includes(t)) return false;
  return true;
}

/** The query as an id fragment (no spaces or quotes), lowercase, or null if it cannot be one. */
export function idQueryOf(query: string): string | null {
  const q = query.trim().toLowerCase();
  return /^[a-z0-9_-]+$/.test(q) ? q : null;
}

export function chatIdMatches(
  chatId: string,
  sessionId: string | undefined,
  idQuery: string,
): boolean {
  return (
    chatId.toLowerCase().includes(idQuery) || (sessionId?.toLowerCase().includes(idQuery) ?? false)
  );
}

function sectionOf(chat: SearchableChat, now: number): ChatSearchSection {
  if (chat.chatId === SPECIAL_THREAD_IDS.manager) return 'manager';
  if (chat.chatId === SPECIAL_THREAD_IDS.speakers) {
    return 'channels';
  }
  if (chat.status === 'archived') return 'archived';
  if (chat.hidden) return 'hidden';
  // spec/04 § Snooze: snoozed ⇔ a wake time still in the future on an active chat.
  if (chat.status === 'active' && chat.snoozedUntil !== null && chat.snoozedUntil > now) {
    return 'snoozed';
  }
  if (chat.pinned) return 'pinned';
  return 'folders';
}

export class ChatSearchIndex {
  private readonly entries = new Map<string, ChatEntry>();

  constructor(
    private readonly opts: ChatSearchIndexOptions,
    private readonly hostId: string,
  ) {}

  /**
   * Bring one chat's entry up to date with its log. Returns false when the
   * chat's log is missing from disk — only its name and preview can be searched.
   */
  private refreshChat(chat: SearchableChat): boolean {
    const path = this.opts.logPath(chat.chatId);
    const st = statSync(path, { throwIfNoEntry: false });
    if (st === undefined) {
      this.entries.delete(chat.chatId);
      return false;
    }
    let entry = this.entries.get(chat.chatId);
    // A log that is now SHORTER than what was read (rewritten, not appended)
    // is re-read whole.
    if (!entry || st.size < entry.offset) {
      entry = { path, offset: 0, messages: new Map() };
      this.entries.set(chat.chatId, entry);
    }
    if (st.size > entry.offset) this.readAppended(entry, st.size);
    return true;
  }

  private readAppended(entry: ChatEntry, size: number): void {
    const fd = openSync(entry.path, 'r');
    try {
      let carry: Buffer = Buffer.alloc(0);
      let position = entry.offset;
      while (position < size) {
        const want = Math.min(READ_CHUNK, size - position);
        const chunk = Buffer.allocUnsafe(want);
        const got = readSync(fd, chunk, 0, want, position);
        if (got === 0) break;
        position += got;
        const buf: Buffer =
          carry.length > 0
            ? Buffer.concat([carry, chunk.subarray(0, got)])
            : chunk.subarray(0, got);
        let start = 0;
        for (let nl = buf.indexOf(10, start); nl >= 0; nl = buf.indexOf(10, start)) {
          const line = buf.subarray(start, nl);
          start = nl + 1;
          entry.offset += line.length + 1;
          if (line.length > 0) this.ingestLine(entry, line);
        }
        // An unterminated tail is a line still being written: leave it for the
        // next refresh rather than reading half of it.
        carry = Buffer.from(buf.subarray(start));
      }
    } finally {
      closeSync(fd);
    }
  }

  private ingestLine(entry: ChatEntry, line: Buffer): void {
    if (!holdsMessage(line)) return;
    let record: { seq?: unknown; branchId?: unknown; rec?: { k?: unknown; event?: WireEvent } };
    try {
      record = JSON.parse(line.toString('utf8'));
    } catch (err) {
      this.opts.onCorruptLine?.({ path: entry.path, message: (err as Error).message });
      return;
    }
    const ev = record.rec?.k === 'event' ? record.rec.event : undefined;
    if (ev?.type !== 'chat.message' || typeof record.seq !== 'number') return;
    if (ev.role !== 'user' && ev.role !== 'assistant') return;
    const branchId = typeof record.branchId === 'string' ? record.branchId : '';
    const key = `${branchId} ${record.seq}`;
    if (ev.content.length === 0) {
      entry.messages.delete(key);
      return;
    }
    entry.messages.set(key, {
      role: ev.role,
      text: ev.content,
      lower: matchForm(ev.content),
      branchId,
      seq: record.seq,
      createdAt: typeof ev.createdAt === 'number' ? ev.createdAt : null,
    });
  }

  /**
   * Build the index in the background, yielding to the event loop between
   * chats so the host stays responsive while the logs are read.
   */
  async warm(chats: SearchableChat[]): Promise<void> {
    for (const chat of chats) {
      if (chat.status === 'deleted') continue;
      this.refreshChat(chat);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /** How many chats the index currently holds a log for. */
  size(): number {
    return this.entries.size;
  }

  /**
   * Search `chats` for `query`, returning the top `limit` hits. Deleted chats
   * are never searched. Brings every chat up to date with its log first,
   * so a message written a moment ago is findable. Archived chats are left out
   * unless `includeArchived`, hidden ones unless `includeHidden`. With `fullText` false only
   * chat names are searched and no log is read.
   */
  search(
    chats: SearchableChat[],
    query: string,
    limit: number,
    fullText = true,
    includeArchived = false,
    includeHidden = false,
  ): ChatSearchResult {
    const terms = queryTerms(query);
    const now = this.opts.now();
    const idQuery = idQueryOf(query);
    const live = chats.filter(
      (c) =>
        c.status !== 'deleted' &&
        (includeArchived || c.status !== 'archived') &&
        (includeHidden || !c.hidden),
    );
    const liveIds = new Set(live.map((c) => c.chatId));
    for (const id of [...this.entries.keys()]) if (!liveIds.has(id)) this.entries.delete(id);

    let transcriptsMissing = 0;
    const found: {
      hit: ChatSearchHit;
      message: IndexedMessage | null;
      previewMatch: boolean;
    }[] = [];
    for (const chat of live) {
      if (fullText && !this.refreshChat(chat)) transcriptsMissing += 1;
      if (terms.length === 0) continue;
      const nameMatch = chat.name !== null && includesAll(matchForm(chat.name), terms);
      const messages = fullText ? (this.entries.get(chat.chatId)?.messages.values() ?? []) : [];
      const bounds = chat.track ? new Map(chat.track.map((t) => [t.branchId, t.upperBound])) : null;
      let matches = 0;
      let newest: IndexedMessage | null = null;
      for (const m of messages) {
        if (bounds && !(m.seq <= (bounds.get(m.branchId) ?? -1))) continue;
        if (!includesAll(m.lower, terms)) continue;
        matches += 1;
        if (newest === null || m.seq > newest.seq) newest = m;
      }
      // The stored first-message preview stands in for a log that has no match.
      const previewMatch =
        fullText &&
        matches === 0 &&
        chat.preview !== null &&
        includesAll(matchForm(chat.preview), terms);
      // Pasting a chat's id (or its backend session id) finds that chat.
      const idMatch = idQuery !== null && chatIdMatches(chat.chatId, chat.claudeSessionId, idQuery);
      if (!nameMatch && matches === 0 && !previewMatch && !idMatch) continue;
      found.push({
        hit: {
          chatId: chat.chatId,
          hostId: this.hostId,
          name: chat.name,
          preview: chat.preview,
          folder: chat.folder,
          status: chat.status,
          section: sectionOf(chat, now),
          pinned: chat.pinned,
          snoozedUntil: chat.snoozedUntil,
          lastUpdated: chat.lastUpdated,
          jobId: null,
          nameMatch,
          nameHighlights: nameMatch ? highlightRanges(chat.name!, terms) : [],
          messageMatches: previewMatch ? 1 : matches,
          snippet: null,
        },
        message: newest,
        previewMatch,
      });
    }
    found.sort((a, b) => compareChatSearchHits(a.hit, b.hit));
    const top = found.slice(0, limit);
    // Snippets are only worth making for the hits going back.
    for (const { hit, message, previewMatch } of top) {
      if (message !== null) {
        hit.snippet = {
          ...makeSnippet(message.text, terms),
          role: message.role,
          seq: message.seq,
          createdAt: message.createdAt,
        };
      } else if (previewMatch) {
        hit.snippet = {
          ...makeSnippet(hit.preview!, terms),
          role: 'user',
          seq: null,
          createdAt: null,
        };
      }
    }
    return {
      hits: top.map((f) => f.hit),
      total: found.length,
      searchedChats: live.length,
      transcriptsMissing,
    };
  }
}

export interface ChatSearchHandlerDeps {
  index: ChatSearchIndex;
  /** Settles when the background build has finished (it never rejects). */
  ready: Promise<void>;
  listChats: () => SearchableChat[];
  hostId: string;
  logger: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
}

/**
 * Answer one `patch.chat_search.request` with exactly one response. A request
 * that lands while the index is still being built waits for the build: an
 * answer from a half-built index would read as "not found" for chats it had
 * simply not reached yet.
 */
export async function handleChatSearchRequest(
  event: Extract<WireEvent, { type: 'patch.chat_search.request' }>,
  deps: ChatSearchHandlerDeps,
  sender: (e: WireEvent) => void,
): Promise<void> {
  await deps.ready;
  const started = Date.now();
  try {
    const result = deps.index.search(
      deps.listChats(),
      event.query,
      event.limit,
      event.fullText !== false,
      event.includeArchived === true,
      event.includeHidden === true,
    );
    deps.logger.info(
      {
        tookMs: Date.now() - started,
        total: result.total,
        searchedChats: result.searchedChats,
        transcriptsMissing: result.transcriptsMissing,
      },
      'chat search answered',
    );
    sender({
      type: 'patch.chat_search.response',
      requestId: event.requestId,
      hostId: deps.hostId,
      ok: true,
      hits: result.hits,
      total: result.total,
      searchedChats: result.searchedChats,
      transcriptsMissing: result.transcriptsMissing,
    });
  } catch (err) {
    const message = (err as Error).message;
    deps.logger.error({ err: message }, 'chat search failed');
    sender({
      type: 'patch.chat_search.response',
      requestId: event.requestId,
      hostId: deps.hostId,
      ok: false,
      error: { code: 'internal', message },
    });
  }
}
