// The host's end of a PTY runner (`ptyHelper.ts` describes the protocol): one
// unix-socket connection to `<dir>/sock`, line framed.

import { connect, type Socket } from 'node:net';
import { join } from 'node:path';

export interface PtyLinkHandlers {
  /** Terminal output starting at absolute offset `start`; `replay` when it was already in the log at attach. */
  onData: (start: number, data: Buffer, replay: boolean) => void;
  /** The shell ended with this status. */
  onExit: (code: number) => void;
  /** The connection ended (after `onExit`, or because the runner is gone). */
  onClose: () => void;
}

export class PtyLink {
  private socket: Socket | null = null;
  private buf = '';
  private next = 0;
  private replayEnd = 0;
  private closed = false;

  private constructor(private readonly handlers: PtyLinkHandlers) {}

  /**
   * Connect to a runner and attach from `offset`. The runner creates its socket
   * a moment after it starts, so a missing or refused socket is retried until
   * `waitMs`; `waitMs: 0` tries once (adopting a runner that should be there).
   */
  static async attach(
    dir: string,
    offset: number,
    handlers: PtyLinkHandlers,
    waitMs: number,
  ): Promise<PtyLink> {
    const link = new PtyLink(handlers);
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        await link.open(join(dir, 'sock'));
        break;
      } catch (err) {
        if (Date.now() >= deadline) throw err;
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    link.write(`A ${offset}\n`);
    return link;
  }

  private open(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connect(path);
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.removeListener('error', reject);
        this.socket = socket;
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => this.read(chunk));
        socket.on('error', () => undefined);
        socket.on('close', () => {
          if (this.closed) return;
          this.closed = true;
          this.handlers.onClose();
        });
        resolve();
      });
    });
  }

  private read(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const nl = this.buf.indexOf('\n');
      if (nl === -1) return;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      const arg = line.slice(2);
      if (line.startsWith('O ')) {
        const [start, end] = arg.split(' ').map(Number);
        this.next = start as number;
        this.replayEnd = end as number;
      } else if (line.startsWith('D ')) {
        const data = Buffer.from(arg, 'base64');
        const start = this.next;
        this.next += data.length;
        this.handlers.onData(start, data, start < this.replayEnd);
      } else if (line.startsWith('X ')) {
        this.handlers.onExit(Number(arg));
      }
    }
  }

  private write(line: string): void {
    if (this.closed || !this.socket) return;
    this.socket.write(line);
  }

  input(data: string): void {
    this.write(`I ${Buffer.from(data, 'utf8').toString('base64')}\n`);
  }

  resize(cols: number, rows: number): void {
    this.write(`R ${cols} ${rows}\n`);
  }

  /** End the shell (its whole process group). */
  kill(): void {
    this.write('K\n');
  }

  /** Let go without ending anything: the runner and its shell carry on. */
  detach(): void {
    this.closed = true;
    this.socket?.destroy();
  }
}
