// The server's log of each chat's transcript (spec/01 § Message log).
//
// Every transcript event a host sends passes through `commit` before anything
// is broadcast: it is written to the chat's append-only file first, so what a
// surface has seen live is always already on the server's disk. A resend of an
// event the server holds is a no-op, so a host that replays after a dropped link
// cannot double a message. Live streaming (deltas, state, progress) is not part
// of the transcript and never touches this.
//
// Each entry's provider id (`nativeRef`) is kept with it on disk and held beside
// the log in memory, so nothing read out of the store for a surface carries it.
// Turn boundaries (`chat.turn_started`, `chat.turn_ended`) are kept beside the
// entries too, by turn id: each sits at the chat's highest seq when it happened
// and takes no seq of its own, so it can never collide with an entry.
//
// While a chat's host is online the host's own log answers replays; the server's
// copy answers them when it is not, and is what rebuilds a host's log that was
// lost (`patch.log_restore`).
//
// One synchronous append per finished event: a process crash loses nothing, and
// the operating system flushes it to disk shortly after. A person's own message
// is fsynced at once, the same policy the host's log keeps.

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Logger } from 'pino';
import {
  headCodePoints,
  LOGGED_EVENT_TYPES,
  TURN_BOUNDARY_TYPES,
  type ChatTurnEndedEvent,
  type ChatTurnStartedEvent,
  type NativeRef,
  type WireEvent,
} from '@patch/wire';
import {
  matchMessages,
  RecordTextIndex,
  searchableMessage,
  type RecordMatch,
  type RecordMessage,
} from './record-search.js';

const MAX_EVENTS_PER_CHAT = 50_000;

/** A tool result bigger than this is kept as a reference, as a host's own log keeps it. */
export const BLOB_INLINE_LIMIT_BYTES = 4 * 1024;
const PREVIEW_CHARS = 200;
const SHA_RE = /^[0-9a-f]{64}$/;

function isBlobRef(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { $blob?: unknown }).$blob === 'string'
  );
}

/** The start of a result's text, so a reader that never opens the blob has something to show. */
function previewOf(result: unknown, json: string): string {
  if (typeof result === 'string') return headCodePoints(result, PREVIEW_CHARS);
  const blocks = Array.isArray(result) ? result : [result];
  const parts: string[] = [];
  for (const b of blocks) {
    if (typeof b !== 'object' || b === null) continue;
    const block = b as { type?: unknown; text?: unknown };
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[image]');
  }
  const text = parts.length > 0 ? parts.join('\n') : json;
  return headCodePoints(text, PREVIEW_CHARS);
}

/** The events a replay is made of: the transcript, as opposed to live-only frames. */
export function isTranscriptEvent(event: WireEvent): boolean {
  switch (event.type) {
    case 'chat.message':
    case 'chat.tool_call':
    case 'chat.tool_result':
    case 'chat.provider_context':
    case 'chat.note':
    case 'chat.error':
    case 'chat.artifact':
      return true;
    // A summary marked `live` is a running label, replaced by the final one.
    case 'chat.tool_run_summary':
      return event.live !== true;
    default:
      return false;
  }
}

/** A turn as the record holds it: its start and its end, once each has arrived. */
export interface RecordedTurn {
  turnId: string;
  started?: ChatTurnStartedEvent;
  ended?: ChatTurnEndedEvent;
}

function sameRef(a: NativeRef | undefined, b: NativeRef | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The event without the provider id it may carry. */
function withoutRef<E extends WireEvent>(event: E): { bare: E; ref: NativeRef | undefined } {
  const { nativeRef, ...bare } = event as E & { nativeRef?: NativeRef };
  return { bare: bare as E, ref: nativeRef };
}

/** What a surface is sent of a host's event: everything but the provider id. */
export function forSurfaces<E extends WireEvent>(event: E): E {
  return (event as { nativeRef?: unknown }).nativeRef === undefined
    ? event
    : withoutRef(event).bare;
}

/** The tool whose question the user answers in a card rather than approves (spec/04 § Questions). */
export const QUESTION_TOOL = 'AskUserQuestion';

/**
 * What an event IS, apart from its content: two different things at one seq is
 * a numbering fault, while the same thing with a different payload is an update
 * (an attachment added, a result filled in).
 */
function identityOf(event: WireEvent): string {
  switch (event.type) {
    case 'chat.message':
      return `message ${event.role}`;
    case 'chat.tool_call':
    case 'chat.tool_result':
      return `${event.type} ${event.callId}`;
    case 'chat.artifact':
      return `${event.type} ${event.artifactId}`;
    case 'chat.tool_run_summary':
      return `${event.type} ${event.callIds.join(',')}`;
    default:
      return event.type;
  }
}

export type CommitOutcome =
  /** First time this seq was seen. */
  | 'new'
  /** The same event, resent. */
  | 'duplicate'
  /** Same event at this seq with a changed payload; the newer is kept. */
  | 'updated'
  /** A different event already holds this seq. Nothing is kept. */
  | 'conflict'
  /** Not a transcript event, or it carries no usable seq. */
  | 'ignored';

export interface ChatLogStoreOptions {
  /** Where the per-chat files live. Absent keeps the log in memory only. */
  dataDir?: string;
  logger: Pick<Logger, 'warn'>;
  /** How many events of one chat are held in memory; the oldest go first. */
  maxEventsPerChat?: number;
}

export class ChatLogStore {
  private readonly dir: string | null;
  private readonly logger: Pick<Logger, 'warn'>;
  private readonly maxEvents: number;
  private readonly chats = new Map<string, Map<number, WireEvent>>();
  /** Each held entry's provider id, by chat and seq. */
  private readonly refs = new Map<string, Map<number, NativeRef>>();
  /** Each chat's turns, by turn id. */
  private readonly turnsByChat = new Map<string, Map<string, RecordedTurn>>();
  /**
   * How far a host's log of each chat is known to reach with events the server
   * does not keep (a tool-run summary, an artifact). Without it the server's
   * high-water mark sits one short of the host's on almost every chat, and log
   * sync asks the host about every one of them again on each reconnect.
   */
  private readonly reach = new Map<string, number>();
  /**
   * The questions asked in each chat and how each was answered, by request id.
   * A question is history: a reload draws its card, greyed out or with the
   * picks marked, rather than two bare tool rows. Kept beside the log rather
   * than in it, so a question asked again after a host restart is never
   * refused or swallowed as a duplicate of the first asking.
   */
  /** Requests asked and not yet answered, by chat; live state, not history. */
  private readonly open = new Map<string, Map<string, WireEvent>>();
  private readonly questions = new Map<
    string,
    Map<string, { request: WireEvent; response?: WireEvent }>
  >();

  /** Message text of each chat's file, for search without loading the whole record. */
  private readonly text = new RecordTextIndex();

  constructor(opts: ChatLogStoreOptions) {
    this.logger = opts.logger;
    this.maxEvents = opts.maxEventsPerChat ?? MAX_EVENTS_PER_CHAT;
    this.dir = opts.dataDir ? join(opts.dataDir, 'chat-logs') : null;
    if (this.dir) mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Take a transcript event into the log, durably, and say what it was. The
   * caller broadcasts only after this returns, and not at all for `duplicate`
   * or `conflict`.
   */
  commit(event: WireEvent): CommitOutcome {
    if (event.type === 'chat.turn_started' || event.type === 'chat.turn_ended') {
      return this.commitTurn(event);
    }
    if (!isTranscriptEvent(event)) {
      // History the server does not keep still says how far the host's log reaches.
      if (LOGGED_EVENT_TYPES.has(event.type as never)) {
        const { chatId, seq } = event as { chatId?: unknown; seq?: unknown };
        if (typeof chatId === 'string' && typeof seq === 'number' && seq >= 0) {
          this.noteReach(chatId, seq);
        }
      }
      return 'ignored';
    }
    const { chatId, seq } = event as { chatId?: unknown; seq?: unknown };
    if (typeof chatId !== 'string' || typeof seq !== 'number' || seq < 0) return 'ignored';
    // A replay and the live stream carry the same event under the same seq.
    // Drop the routing tag a replay frame carries; it is not part of the event.
    const { forSurfaceId: _route, ...whole } = event as WireEvent & { forSurfaceId?: string };
    void _route;
    const { bare, ref: sent } = withoutRef(whole as WireEvent);
    // A big tool result is kept as a reference to a stored body, so one of them
    // never weighs down the log or a replay of it.
    const stored = this.externalize(bare);
    const log = this.load(chatId);
    const had = log.get(seq);
    const json = JSON.stringify(stored);
    const heldRef = this.refs.get(chatId)?.get(seq);
    // A resend without the provider id (an older host) never takes it away.
    const ref = sent ?? (had !== undefined ? heldRef : undefined);
    let outcome: CommitOutcome = 'new';
    if (had !== undefined) {
      if (identityOf(had) !== identityOf(stored)) {
        this.logger.warn(
          { chatId, seq, held: identityOf(had), got: identityOf(stored) },
          'chat-log-store: a different event already holds this seq; not committed',
        );
        return 'conflict';
      }
      if (JSON.stringify(had) === json) {
        if (sameRef(heldRef, ref)) return 'duplicate';
        // Only the provider id is new (a record import topping it up): kept,
        // and nothing a surface shows has changed.
        this.setRef(chatId, seq, ref);
        this.append(chatId, lineOf(stored, ref), false);
        return 'duplicate';
      }
      outcome = 'updated';
    }
    log.set(seq, stored);
    this.setRef(chatId, seq, ref);
    this.trim(log);
    this.append(
      chatId,
      lineOf(stored, ref),
      event.type === 'chat.message' && event.role === 'user',
    );
    return outcome;
  }

  /**
   * Keep a turn boundary, durably. The same boundary sent again is a
   * duplicate; a different one for a turn's start or end that is already held
   * replaces it (a host closing a turn its restart found open says so last).
   */
  private commitTurn(event: ChatTurnStartedEvent | ChatTurnEndedEvent): CommitOutcome {
    const { forSurfaceId: _route, ...whole } = event as typeof event & { forSurfaceId?: string };
    void _route;
    const boundary = whole as ChatTurnStartedEvent | ChatTurnEndedEvent;
    const turns = this.turnsOf(boundary.chatId);
    const turn = turns.get(boundary.turnId) ?? { turnId: boundary.turnId };
    const held = boundary.type === 'chat.turn_started' ? turn.started : turn.ended;
    const json = JSON.stringify(boundary);
    if (held !== undefined && JSON.stringify(held) === json) return 'duplicate';
    if (boundary.type === 'chat.turn_started') turn.started = boundary;
    else turn.ended = boundary;
    turns.set(boundary.turnId, turn);
    this.append(boundary.chatId, JSON.stringify({ turn: boundary }), true);
    return held === undefined ? 'new' : 'updated';
  }

  /**
   * The chat's turns as the record holds them, in the order they began (a turn
   * whose start never arrived is placed at its end).
   */
  turns(chatId: string): RecordedTurn[] {
    const placeOf = (t: RecordedTurn): [number, number] => {
      const b = t.started ?? t.ended!;
      return [b.seq, b.at];
    };
    return [...this.turnsOf(chatId).values()].sort((a, b) => {
      const [sa, ta] = placeOf(a);
      const [sb, tb] = placeOf(b);
      return sa - sb || ta - tb;
    });
  }

  /** The provider's own id for the entry at `seq`, when the host sent one. */
  nativeRef(chatId: string, seq: number): NativeRef | undefined {
    this.load(chatId);
    return this.refs.get(chatId)?.get(seq);
  }

  private turnsOf(chatId: string): Map<string, RecordedTurn> {
    this.load(chatId);
    let turns = this.turnsByChat.get(chatId);
    if (!turns) {
      turns = new Map();
      this.turnsByChat.set(chatId, turns);
    }
    return turns;
  }

  private setRef(chatId: string, seq: number, ref: NativeRef | undefined): void {
    let refs = this.refs.get(chatId);
    if (ref === undefined) {
      refs?.delete(seq);
      return;
    }
    if (!refs) {
      refs = new Map();
      this.refs.set(chatId, refs);
    }
    refs.set(seq, ref);
  }

  /** Take in events that are not new to surfaces: a replay, or a batch of one. */
  observe(event: WireEvent): void {
    if (event.type === 'chat.replay_batch') {
      for (const inner of event.events) this.observe(inner as WireEvent);
      return;
    }
    this.notePermission(event);
    this.commit(event);
  }

  /**
   * Keep a question and its answer (spec/01 § Chat record). Takes any event and
   * ignores everything but a question's request and the response to one; never
   * changes what is broadcast.
   */
  notePermission(event: WireEvent): void {
    if (event.type === 'chat.permission_request') {
      // Every request is open until answered; only a question is history.
      const { forSurfaceId: _r, ...open } = event as WireEvent & { forSurfaceId?: string };
      void _r;
      let opened = this.open.get(event.chatId);
      if (!opened) {
        opened = new Map();
        this.open.set(event.chatId, opened);
      }
      opened.set(event.requestId, open as WireEvent);
      if (event.request.tool !== QUESTION_TOOL) return;
      const { forSurfaceId: _route, ...whole } = event as WireEvent & { forSurfaceId?: string };
      void _route;
      const asked = this.questionsOf(event.chatId);
      const held = asked.get(event.requestId);
      if (held && JSON.stringify(held.request) === JSON.stringify(whole)) return;
      asked.set(event.requestId, { ...held, request: whole as WireEvent });
      this.append(event.chatId, JSON.stringify({ question: whole }), false);
      return;
    }
    if (event.type === 'chat.permission_response' && typeof event.chatId === 'string') {
      this.open.get(event.chatId)?.delete(event.requestId);
      const asked = this.questionsOf(event.chatId);
      const held = asked.get(event.requestId);
      if (!held) return;
      const { forSurfaceId: _route, ...whole } = event as WireEvent & { forSurfaceId?: string };
      void _route;
      if (held.response && JSON.stringify(held.response) === JSON.stringify(whole)) return;
      held.response = whole as WireEvent;
      this.append(event.chatId, JSON.stringify({ answer: whole }), false);
    }
  }

  /**
   * The chat's record with `seq > fromSeq` as a surface replays it: the log in
   * seq order, with each question placed at its own seq and followed by its
   * answer once it has one. A question with no answer yet is the host's to
   * show: it restates the questions it is still waiting on.
   */
  replay(chatId: string, fromSeq: number): WireEvent[] {
    const events = this.read(chatId, fromSeq);
    const asked = [...this.questionsOf(chatId).values()]
      .filter(
        (q): q is { request: WireEvent; response: WireEvent } =>
          q.response !== undefined && (q.request as { seq: number }).seq > fromSeq,
      )
      .sort((a, b) => (a.request as { seq: number }).seq - (b.request as { seq: number }).seq);
    if (asked.length === 0) return events;
    const out: WireEvent[] = [];
    let i = 0;
    for (const e of events) {
      const seq = (e as { seq: number }).seq;
      while (i < asked.length && (asked[i]!.request as { seq: number }).seq <= seq) {
        out.push(asked[i]!.request, asked[i]!.response);
        i += 1;
      }
      out.push(e);
    }
    for (; i < asked.length; i += 1) out.push(asked[i]!.request, asked[i]!.response);
    return out;
  }

  /**
   * One page of the chat's record (spec/03 § Chat history): entries after a
   * position, the `limit` before one, or the last `limit`. `more` says entries
   * remain in the direction asked.
   */
  page(
    chatId: string,
    at: { after?: number; before?: number; limit: number },
  ): { entries: WireEvent[]; more: boolean; through: number } {
    const all = this.replay(chatId, -1);
    const through = this.highWater(chatId);
    const seqOf = (e: WireEvent, i: number): number => {
      const seq = (e as { seq?: unknown }).seq;
      // An answer has no seq of its own; it travels with the question before it.
      if (typeof seq === 'number') return seq;
      for (let j = i - 1; j >= 0; j--) {
        const prev = (all[j] as { seq?: unknown }).seq;
        if (typeof prev === 'number') return prev;
      }
      return -1;
    };
    if (at.after !== undefined) {
      const from = all.findIndex((e, i) => seqOf(e, i) > at.after!);
      if (from === -1) return { entries: [], more: false, through };
      const entries = all.slice(from, from + at.limit);
      return { entries, more: from + at.limit < all.length, through };
    }
    let end = all.length;
    if (at.before !== undefined) {
      end = all.findIndex((e, i) => seqOf(e, i) >= at.before!);
      if (end === -1) end = all.length;
    }
    let start = Math.max(0, end - at.limit);
    // Never split a question from its answer.
    while (start > 0 && (all[start] as { seq?: unknown }).seq === undefined) start -= 1;
    return { entries: all.slice(start, end), more: start > 0, through };
  }

  /** Every request on the chat still waiting for an answer. */
  openRequests(chatId: string): WireEvent[] {
    return [...(this.open.get(chatId)?.values() ?? [])];
  }

  private questionsOf(chatId: string): Map<string, { request: WireEvent; response?: WireEvent }> {
    this.load(chatId);
    let asked = this.questions.get(chatId);
    if (!asked) {
      asked = new Map();
      this.questions.set(chatId, asked);
    }
    return asked;
  }

  /**
   * The highest seq the server holds for the chat, or knows the host's log
   * reaches with events it does not keep; -1 when it holds none.
   */
  highWater(chatId: string): number {
    let max = this.load(chatId).size > 0 ? (this.reach.get(chatId) ?? -1) : -1;
    for (const seq of this.chats.get(chatId)!.keys()) if (seq > max) max = seq;
    return max;
  }

  /**
   * Record that the host's log of a chat reaches `seq`, though the server keeps
   * nothing there. Kept on disk with the chat, so a restart does not forget it.
   * Only for a chat the server already holds: log sync leaves the others alone.
   */
  noteReach(chatId: string, seq: number): void {
    if (this.load(chatId).size === 0) return;
    if (seq <= this.highWater(chatId)) return;
    this.reach.set(chatId, seq);
    this.append(chatId, JSON.stringify({ reach: seq }), false);
  }

  /**
   * True when the server keeps a record of the chat, without loading it: what
   * search uses to count the chats it could answer for.
   */
  holds(chatId: string): boolean {
    if ((this.chats.get(chatId)?.size ?? 0) > 0) return true;
    return this.dir !== null && existsSync(this.pathOf(chatId));
  }

  /**
   * The chat's user and assistant messages containing every term, the newest as
   * the snippet; `null` for none (spec/03 § Chat search). Reads the record on
   * disk incrementally and never loads a chat's whole log to do it.
   */
  searchMessages(chatId: string, terms: string[]): RecordMatch | null {
    if (this.dir !== null) return matchMessages(this.text.messages(this.pathOf(chatId)), terms);
    const messages: [number, RecordMessage][] = [];
    for (const [seq, event] of this.chats.get(chatId) ?? []) {
      const m = searchableMessage(event);
      if (m) messages.push([seq, m]);
    }
    return matchMessages(messages, terms);
  }

  private pathOf(chatId: string): string {
    return join(this.dir as string, `${fileName(chatId)}.jsonl`);
  }

  /** True when the server holds anything for the chat. */
  has(chatId: string): boolean {
    return this.load(chatId).size > 0;
  }

  /** The chat's events with `seq > fromSeq`, in seq order. `fromSeq` of -1 is everything. */
  read(chatId: string, fromSeq: number, limit?: number): WireEvent[] {
    const events = [...this.load(chatId).entries()]
      .filter(([seq]) => seq > fromSeq)
      .sort((a, b) => a[0] - b[0])
      .map(([, e]) => e);
    return limit === undefined ? events : events.slice(0, limit);
  }

  /** Writes are synchronous, so there is never anything held back. Kept for callers that shut down tidily. */
  async flush(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * A tool result over the inline limit becomes a content-addressed reference
   * (the same shape a host's log uses, so a surface fetches it the same way), and
   * its body is stored once under `chat-logs/blobs`. With no data dir the result
   * stays inline: there is nowhere to keep a body.
   */
  private externalize(event: WireEvent): WireEvent {
    if (event.type !== 'chat.tool_result' || this.dir === null) return event;
    const result = (event as { result?: unknown }).result;
    if (isBlobRef(result)) return event;
    const json = JSON.stringify(result ?? null);
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes <= BLOB_INLINE_LIMIT_BYTES) return event;
    const sha = createHash('sha256').update(json).digest('hex');
    const path = this.blobPath(sha);
    try {
      if (!existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, json);
        renameSync(tmp, path);
      }
    } catch (err) {
      // Keep the body inline rather than lose it.
      this.logger.warn({ err, sha }, 'chat-log-store: could not store a large result; kept inline');
      return event;
    }
    return {
      ...event,
      result: { $blob: sha, bytes, mime: 'application/json', preview: previewOf(result, json) },
    } as WireEvent;
  }

  private blobPath(sha: string): string {
    return join(this.dir as string, 'blobs', sha.slice(0, 2), sha.slice(2));
  }

  /** The stored body a reference stands for, or null when the server does not hold it. */
  readBlob(sha: string): { bytes: Buffer; mime: string } | null {
    if (this.dir === null || !SHA_RE.test(sha)) return null;
    try {
      return { bytes: readFileSync(this.blobPath(sha)), mime: 'application/json' };
    } catch {
      return null;
    }
  }

  private append(chatId: string, line: string, durable: boolean): void {
    if (this.dir === null) return;
    const path = join(this.dir, `${fileName(chatId)}.jsonl`);
    try {
      if (!durable) {
        appendFileSync(path, `${line}\n`);
        return;
      }
      const fd = openSync(path, 'a');
      try {
        writeSync(fd, `${line}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      this.logger.warn({ err, chatId }, 'chat-log-store: could not write the chat log');
    }
  }

  private load(chatId: string): Map<number, WireEvent> {
    const held = this.chats.get(chatId);
    if (held) return held;
    const log = new Map<number, WireEvent>();
    this.chats.set(chatId, log);
    if (this.dir === null) return log;
    const path = join(this.dir, `${fileName(chatId)}.jsonl`);
    if (!existsSync(path)) return log;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      this.logger.warn({ err, chatId }, 'chat-log-store: could not read the chat log');
      return log;
    }
    // A crash can leave a last line with no newline. End it, or the next append
    // would share its line and be skipped on every later load along with it.
    if (text !== '' && !text.endsWith('\n')) {
      try {
        appendFileSync(path, '\n');
      } catch (err) {
        this.logger.warn({ err, chatId }, 'chat-log-store: could not end a torn last line');
      }
    }
    for (const line of text.split('\n')) {
      if (line === '') continue;
      try {
        const event = JSON.parse(line) as WireEvent;
        const seq = (event as { seq?: unknown }).seq;
        const reach = (event as { reach?: unknown }).reach;
        const rec = event as { question?: WireEvent; answer?: WireEvent; turn?: WireEvent };
        // A torn last line from a crash, or a record that is not an event, is skipped.
        if (typeof seq === 'number') {
          const { bare, ref } = withoutRef(event);
          log.set(seq, bare);
          // The latest line for a seq says what is kept, provider id included.
          this.setRef(chatId, seq, ref);
        } else if (rec.turn !== undefined && TURN_BOUNDARY_TYPES.has(rec.turn.type)) {
          const b = rec.turn as ChatTurnStartedEvent | ChatTurnEndedEvent;
          const turns = this.turnsByChat.get(chatId) ?? new Map<string, RecordedTurn>();
          this.turnsByChat.set(chatId, turns);
          const turn = turns.get(b.turnId) ?? { turnId: b.turnId };
          if (b.type === 'chat.turn_started') turn.started = b;
          else turn.ended = b;
          turns.set(b.turnId, turn);
        } else if (rec.question?.type === 'chat.permission_request') {
          const q = rec.question;
          const asked = this.questions.get(chatId) ?? new Map();
          this.questions.set(chatId, asked);
          asked.set(q.requestId, { ...asked.get(q.requestId), request: q });
        } else if (rec.answer?.type === 'chat.permission_response') {
          const held = this.questions.get(chatId)?.get(rec.answer.requestId);
          if (held) held.response = rec.answer;
        } else if (typeof reach === 'number' && reach > (this.reach.get(chatId) ?? -1)) {
          this.reach.set(chatId, reach);
        }
      } catch {
        continue;
      }
    }
    this.trim(log);
    return log;
  }

  /**
   * Hold a chat to the cap, dropping its lowest seqs. Seqs do not arrive in
   * order, and a chat can hold too many to spread into `Math.min`, so the
   * oldest is found by a scan (one over the cap, on commit) or a sort (many, on load).
   */
  private trim(log: Map<number, WireEvent>): void {
    const excess = log.size - this.maxEvents;
    if (excess <= 0) return;
    if (excess === 1) {
      let oldest = Infinity;
      for (const seq of log.keys()) if (seq < oldest) oldest = seq;
      log.delete(oldest);
      return;
    }
    const seqs = [...log.keys()].sort((a, b) => a - b);
    for (const seq of seqs.slice(0, excess)) log.delete(seq);
  }
}

/** One log line: the entry, with its provider id when it has one. */
function lineOf(event: WireEvent, ref: NativeRef | undefined): string {
  return JSON.stringify(ref === undefined ? event : { ...event, nativeRef: ref });
}

/** A chat id is a ULID or a fixed thread name, but never trust it as a path segment. */
function fileName(chatId: string): string {
  return chatId.replace(/[^A-Za-z0-9_-]/g, '_');
}
