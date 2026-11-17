// Sending the server the history its record did not keep (spec/01 § Chat record).
//
// A server's record of a chat once held only messages, tool calls, results and
// errors. Artifacts, tool-run summaries and answered questions lived only in
// the host's log, so a chat opened from the server's record would lack them.
// Once, per chat, the host sends exactly those, and the server takes them in
// without broadcasting. One chat at a time, each acknowledged before the next,
// so it never floods the link or the server; a chat is marked done only on the
// server's acknowledgement, and an interrupted run carries on at the next
// connect.

import * as nodeFs from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from 'pino';
import { REPLAY_BATCH_BYTES, type WireEvent } from '@patch/wire';

/** The question tool, whose answered cards are history (spec/04 § Questions). */
const QUESTION_TOOL = 'AskUserQuestion';
/** Give up on this connection if a chat's acknowledgement takes longer than this. */
export const RECORD_IMPORT_ACK_TIMEOUT_MS = 30_000;

export interface RecordImportOptions {
  /** `<patchHome>/record-import.json`: which chats are done, and whether all are. */
  path: string;
  logger: Pick<Logger, 'info' | 'warn'>;
  listChats: () => string[];
  /** The host's own replay of a chat, from the start. */
  replayChat: (chatId: string, emit: (event: WireEvent) => void) => void;
  send: (event: WireEvent) => void;
  fs?: Pick<
    typeof nodeFs,
    'existsSync' | 'readFileSync' | 'writeFileSync' | 'renameSync' | 'mkdirSync'
  >;
  ackTimeoutMs?: number;
  /** Yields between chats; a test passes a synchronous one. */
  defer?: (fn: () => void) => void;
}

/** What of a replay the record lacked: artifacts, final summaries, answered questions. */
export function importable(events: readonly WireEvent[]): WireEvent[] {
  const questions = new Set<string>();
  const out: WireEvent[] = [];
  for (const e of events) {
    if (e.type === 'chat.artifact') out.push(e);
    else if (e.type === 'chat.tool_run_summary' && e.live !== true) out.push(e);
    else if (e.type === 'chat.permission_request' && e.request.tool === QUESTION_TOOL) {
      questions.add(e.requestId);
      out.push(e);
    } else if (e.type === 'chat.permission_response' && questions.has(e.requestId)) out.push(e);
  }
  return out.map((e) => {
    const { forSurfaceId: _route, ...whole } = e as WireEvent & { forSurfaceId?: string };
    void _route;
    return whole as WireEvent;
  });
}

export class RecordImport {
  private readonly fs: NonNullable<RecordImportOptions['fs']>;
  private readonly done = new Set<string>();
  private complete = false;
  private running = false;
  /** The chat whose acknowledgement is awaited, and its timeout. */
  private waiting: { chatId: string; timer: NodeJS.Timeout } | null = null;
  private queue: string[] = [];

  constructor(private readonly opts: RecordImportOptions) {
    this.fs = opts.fs ?? nodeFs;
    this.load();
  }

  /** On a connection to a server that takes the import. */
  start(): void {
    if (this.complete || this.running) return;
    this.running = true;
    this.queue = this.opts.listChats().filter((id) => !this.done.has(id));
    this.opts.logger.info(
      { chats: this.queue.length },
      'record import: sending what the server record lacks',
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
      this.complete = true;
      this.save();
      this.opts.logger.info({}, 'record import: complete');
      return;
    }
    let events: WireEvent[] = [];
    try {
      const all: WireEvent[] = [];
      this.opts.replayChat(chatId, (e) => all.push(e));
      events = importable(all);
    } catch (err) {
      // A chat the host cannot read is reported and left out; nothing more can
      // be sent for it, and it must not hold up every chat after it.
      this.opts.logger.warn({ chatId, err }, 'record import: could not read the chat; skipped');
    }
    if (events.length === 0) {
      this.markDone(chatId);
      this.schedule();
      return;
    }
    const chunks: WireEvent[][] = [[]];
    let bytes = 0;
    for (const e of events) {
      const size = JSON.stringify(e).length;
      const open = chunks[chunks.length - 1]!;
      if (open.length > 0 && (open.length >= 200 || bytes + size > REPLAY_BATCH_BYTES)) {
        chunks.push([]);
        bytes = 0;
      }
      chunks[chunks.length - 1]!.push(e);
      bytes += size;
    }
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
        done?: unknown;
        complete?: unknown;
      };
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
      this.fs.writeFileSync(tmp, JSON.stringify({ complete: this.complete, done: [...this.done] }));
      this.fs.renameSync(tmp, path);
    } catch (err) {
      this.opts.logger.warn({ err, path }, 'record import: could not save progress');
    }
  }
}
