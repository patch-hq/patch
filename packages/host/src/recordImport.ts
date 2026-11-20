// The one-time import of a host's chats into the server's record (spec/01 §
// Chat record).
//
// The server's record is the source for every surface, so it must hold every
// chat the host holds, whole: every logged entry with its provider id
// (`nativeRef`), every turn boundary, every answered question, including chats
// the server has never seen. Once, per chat, the host sends the chat's whole log
// and the server takes it in without broadcasting; the server keeps each entry
// by its seq, so a resend of one it holds changes nothing. One chat at a time,
// each acknowledged before the next, so it never floods the link or the server;
// a chat is marked done only on the server's acknowledgement, and an
// interrupted run carries on at the next connect.
//
// Progress is versioned. A host whose earlier import (which sent only what the
// record then lacked) finished runs this one once more over every chat, which
// tops the record up with turn boundaries and provider ids, and then stops.
// Version 3 runs it once more so the record learns which branch each entry is
// on and holds every side branch's entries (spec/04 § Branching).

import * as nodeFs from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from 'pino';
import { RECORD_FRAME_BYTES, type WireEvent } from '@patch/wire';

/** Give up on this connection if a chat's acknowledgement takes longer than this. */
export const RECORD_IMPORT_ACK_TIMEOUT_MS = 30_000;
/** The progress file's version: a file of an earlier one means the import runs again. */
export const RECORD_IMPORT_VERSION = 3;
/** Most events in one `host.record_import` frame. */
const EVENTS_PER_FRAME = 200;

export interface RecordImportOptions {
  /** `<patchHome>/record-import.json`: which chats are done, and whether all are. */
  path: string;
  logger: Pick<Logger, 'info' | 'warn'>;
  listChats: () => string[];
  /**
   * Every entry of the chat's own record, in log order, as the server takes it;
   * null when the chat is no longer on the host. Throws when it cannot be read.
   */
  recordOf: (chatId: string) => WireEvent[] | null;
  send: (event: WireEvent) => void;
  fs?: Pick<
    typeof nodeFs,
    'existsSync' | 'readFileSync' | 'writeFileSync' | 'renameSync' | 'mkdirSync'
  >;
  ackTimeoutMs?: number;
  /** Yields between chats; a test passes a synchronous one. */
  defer?: (fn: () => void) => void;
}

/** Split a chat's entries into frames no bigger than `RECORD_FRAME_BYTES`. */
export function framesOf(events: readonly WireEvent[]): WireEvent[][] {
  const frames: WireEvent[][] = [[]];
  let bytes = 0;
  for (const raw of events) {
    const { forSurfaceId: _route, ...e } = raw as WireEvent & { forSurfaceId?: string };
    void _route;
    const size = JSON.stringify(e).length;
    const open = frames[frames.length - 1]!;
    if (open.length > 0 && (open.length >= EVENTS_PER_FRAME || bytes + size > RECORD_FRAME_BYTES)) {
      frames.push([]);
      bytes = 0;
    }
    frames[frames.length - 1]!.push(e as WireEvent);
    bytes += size;
  }
  return frames;
}

export class RecordImport {
  private readonly fs: NonNullable<RecordImportOptions['fs']>;
  private readonly done = new Set<string>();
  private complete = false;
  private running = false;
  /** The chat whose acknowledgement is awaited, and its timeout. */
  private waiting: { chatId: string; timer: NodeJS.Timeout } | null = null;
  private queue: string[] = [];
  /** Chats this run could not read: the import is not complete until they are sent. */
  private unread = 0;

  constructor(private readonly opts: RecordImportOptions) {
    this.fs = opts.fs ?? nodeFs;
    this.load();
  }

  /** On a connection to a server that takes the import. */
  start(): void {
    if (this.complete || this.running) return;
    this.running = true;
    this.unread = 0;
    this.queue = this.opts.listChats().filter((id) => !this.done.has(id));
    this.opts.logger.info(
      { chats: this.queue.length, done: this.done.size },
      'record import: sending every chat to the server record',
    );
    this.next();
  }

  /** The link dropped: carry on at the next connect. */
  stop(): void {
    if (this.running) this.save();
    this.running = false;
    if (this.waiting) clearTimeout(this.waiting.timer);
    this.waiting = null;
  }

  onAck(chatId: string): void {
    if (this.waiting?.chatId !== chatId) return;
    clearTimeout(this.waiting.timer);
    this.waiting = null;
    this.markDone(chatId);
    this.schedule();
  }

  isComplete(): boolean {
    return this.complete;
  }

  private schedule(): void {
    const defer = this.opts.defer ?? ((fn: () => void) => setImmediate(fn));
    defer(() => this.next());
  }

  private next(): void {
    if (!this.running || this.waiting) return;
    const chatId = this.queue.shift();
    if (chatId === undefined) {
      this.running = false;
      this.complete = this.unread === 0;
      this.save();
      if (this.complete) this.opts.logger.info({}, 'record import: complete');
      else
        this.opts.logger.warn(
          { unread: this.unread },
          'record import: some chats could not be read; trying them again at the next connect',
        );
      return;
    }
    let events: WireEvent[] | null;
    try {
      events = this.opts.recordOf(chatId);
    } catch (err) {
      // A chat the host cannot read is reported and left out of this run, not
      // marked done: the next connect tries it again. It must not hold up
      // every chat after it.
      this.unread += 1;
      this.opts.logger.warn({ chatId, err }, 'record import: could not read the chat; skipped');
      this.schedule();
      return;
    }
    if (events === null || events.length === 0) {
      this.markDone(chatId);
      this.schedule();
      return;
    }
    const chunks = framesOf(events);
    const timer = setTimeout(() => {
      this.opts.logger.warn(
        { chatId },
        'record import: no acknowledgement; resuming at the next connect',
      );
      this.stop();
    }, this.opts.ackTimeoutMs ?? RECORD_IMPORT_ACK_TIMEOUT_MS);
    timer.unref();
    this.waiting = { chatId, timer };
    chunks.forEach((chunk, i) =>
      this.opts.send({
        type: 'host.record_import',
        chatId,
        events: chunk,
        done: i === chunks.length - 1,
      }),
    );
  }

  private markDone(chatId: string): void {
    this.done.add(chatId);
    // Written every so often rather than per chat: losing the tail of the list
    // costs only resending a few chats, which the server takes as duplicates.
    if (this.done.size % 50 === 0) this.save();
  }

  private load(): void {
    if (!this.fs.existsSync(this.opts.path)) return;
    try {
      const saved = JSON.parse(this.fs.readFileSync(this.opts.path, 'utf8')) as {
        version?: unknown;
        done?: unknown;
        complete?: unknown;
      };
      if (saved.version !== RECORD_IMPORT_VERSION) {
        // An earlier import sent only part of each chat: this one sends all of
        // it, once, for every chat.
        this.opts.logger.info(
          { path: this.opts.path, was: saved.version ?? 1 },
          'record import: an earlier import ran; importing every chat in full once',
        );
        return;
      }
      if (Array.isArray(saved.done))
        for (const id of saved.done) if (typeof id === 'string') this.done.add(id);
      this.complete = saved.complete === true;
    } catch (err) {
      this.opts.logger.warn(
        { err, path: this.opts.path },
        'record import: progress unreadable; starting over',
      );
    }
  }

  private save(): void {
    const { path } = this.opts;
    try {
      this.fs.mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      this.fs.writeFileSync(
        tmp,
        JSON.stringify({
          version: RECORD_IMPORT_VERSION,
          complete: this.complete,
          done: [...this.done],
        }),
      );
      this.fs.renameSync(tmp, path);
    } catch (err) {
      this.opts.logger.warn({ err, path }, 'record import: could not save progress');
    }
  }
}
