// The host outbox (spec/01 § Host outbox, spec/02 § Host outbox).
//
// Every transcript event the host sends the server is appended here first,
// under a position numbered across the whole host. The server acknowledges a
// position once it has committed everything up to it; until then the event is
// kept on disk, so a dropped link, a half-open socket or a host restart costs
// nothing: after every reconnect the host resends what is past the last
// acknowledgement, and the server takes a resend of an event it holds as a
// duplicate.
//
// One file, `<patchHome>/outbox.jsonl`: one `{"p":<position>,"e":<event>}` line
// per event, and `{"ack":<position>}` lines as acknowledgements arrive. The file
// is rewritten with only what is still owed once enough of it is acknowledged.

import * as nodeFs from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from 'pino';
import type { WireEvent } from '@patch/wire';

/** Rewrite the file once this many acknowledged lines have built up. */
export const OUTBOX_COMPACT_AFTER = 2_000;

export interface OutboxEntry {
  position: number;
  event: WireEvent;
}

export interface OutboxOptions {
  path: string;
  logger: Pick<Logger, 'warn' | 'error'>;
  fs?: Pick<
    typeof nodeFs,
    'existsSync' | 'readFileSync' | 'appendFileSync' | 'writeFileSync' | 'renameSync' | 'mkdirSync'
  >;
  compactAfter?: number;
  /** Called after an acknowledgement drops entries. */
  onAck?: () => void;
}

export class Outbox {
  private readonly fs: NonNullable<OutboxOptions['fs']>;
  private readonly compactAfter: number;
  private readonly owed: OutboxEntry[] = [];
  private next = 0;
  private acked = -1;
  /** Lines in the file that an acknowledgement has made dead weight. */
  private deadLines = 0;

  constructor(private readonly opts: OutboxOptions) {
    this.fs = opts.fs ?? nodeFs;
    this.compactAfter = opts.compactAfter ?? OUTBOX_COMPACT_AFTER;
    this.load();
  }

  /** Keep `event` until the server acknowledges it; returns its position. */
  append(event: WireEvent): number {
    const position = this.next++;
    this.owed.push({ position, event });
    this.write(`${JSON.stringify({ p: position, e: event })}\n`);
    return position;
  }

  /** The server has committed every position up to `through`. */
  ack(through: number): void {
    if (through <= this.acked) return;
    this.acked = Math.min(through, this.next - 1);
    let dropped = 0;
    while (this.owed.length > 0 && this.owed[0]!.position <= this.acked) {
      this.owed.shift();
      dropped += 1;
    }
    this.deadLines += dropped + 1;
    if (this.deadLines >= this.compactAfter) this.compact();
    else this.write(`${JSON.stringify({ ack: this.acked })}\n`);
    if (dropped > 0) this.opts.onAck?.();
  }

  /** Everything not yet acknowledged, oldest first. */
  pending(): readonly OutboxEntry[] {
    return this.owed;
  }

  /** How far the server has acknowledged; -1 before the first acknowledgement. */
  acknowledged(): number {
    return this.acked;
  }

  private load(): void {
    const { path } = this.opts;
    if (!this.fs.existsSync(path)) return;
    const byPosition = new Map<number, WireEvent>();
    let lines = 0;
    for (const line of this.fs.readFileSync(path, 'utf8').split('\n')) {
      if (line === '') continue;
      lines += 1;
      let rec: { p?: unknown; e?: unknown; ack?: unknown };
      try {
        rec = JSON.parse(line) as typeof rec;
      } catch {
        // A torn last line from a crash: the event it held was never sent as
        // acknowledged, and the write that tore it is the one that failed.
        this.opts.logger.warn({ path }, 'outbox: skipped an unreadable line');
        continue;
      }
      if (typeof rec.ack === 'number') {
        if (rec.ack > this.acked) this.acked = rec.ack;
      } else if (typeof rec.p === 'number' && rec.e && typeof rec.e === 'object') {
        byPosition.set(rec.p, rec.e as WireEvent);
        if (rec.p >= this.next) this.next = rec.p + 1;
      }
    }
    if (this.acked >= this.next) this.next = this.acked + 1;
    for (const [position, event] of [...byPosition].sort((a, b) => a[0] - b[0])) {
      if (position > this.acked) this.owed.push({ position, event });
    }
    this.deadLines = lines - this.owed.length;
  }

  private compact(): void {
    const { path } = this.opts;
    const body =
      JSON.stringify({ ack: this.acked }) +
      '\n' +
      this.owed.map((o) => JSON.stringify({ p: o.position, e: o.event }) + '\n').join('');
    try {
      const tmp = `${path}.tmp`;
      this.fs.writeFileSync(tmp, body);
      this.fs.renameSync(tmp, path);
      this.deadLines = 1;
    } catch (err) {
      this.opts.logger.error({ err, path }, 'outbox: could not compact the file');
      this.write(`${JSON.stringify({ ack: this.acked })}\n`);
    }
  }

  private write(line: string): void {
    const { path } = this.opts;
    try {
      this.fs.mkdirSync(dirname(path), { recursive: true });
      this.fs.appendFileSync(path, line);
    } catch (err) {
      // Not fatal to the turn: the event is still held in memory and sent, so
      // only a host restart before it is acknowledged could lose it. Said loudly.
      this.opts.logger.error({ err, path }, 'outbox: could not write to the file');
    }
  }
}
