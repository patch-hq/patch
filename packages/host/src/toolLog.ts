// Cross-chat tool-call log — "things agents did" (Settings → Activity).
//
// Every `patch_*` cross-chat tool call reaches `control.ts`'s `toolLogger`
// hook. The server keeps the account's log (`patch.tool_log.entry`, sent
// through the host outbox, spec/01 § Host outbox), but only a server whose
// `auth.ok` says `serverReads` keeps one: an older server would have the
// entries acknowledged and dropped. So until the server on the link says it
// keeps the log, entries go to this host's own `<patchHome>/logs/tool-calls.jsonl`
// (which hosts have always kept), and the first time one does, that file is
// handed to the outbox and deleted. From then on entries go to the outbox.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolLogEntry, WireEvent } from '@patch/wire';

/** The tool-log entry this host sends the server for one call. */
export function toolLogEvent(entry: ToolLogEntry): WireEvent {
  return { type: 'patch.tool_log.entry', entry };
}

export class ToolLogSink {
  private readonly dir: string;
  private readonly path: string;
  /** Whether the server on the link keeps the tool log. */
  private serverKeeps = false;

  constructor(
    patchHome: string,
    /** Into the outbox: kept until the server acknowledges it. */
    private readonly send: (event: WireEvent) => void,
  ) {
    this.dir = join(patchHome, 'logs');
    this.path = join(this.dir, 'tool-calls.jsonl');
  }

  /**
   * On every `auth.ok`: whether this server keeps the tool log. The first one
   * that does is handed whatever the local file holds. Returns how many
   * entries were handed over.
   */
  onServer(keepsToolLog: boolean): number {
    this.serverKeeps = keepsToolLog;
    return keepsToolLog ? this.handOver() : 0;
  }

  append(entry: ToolLogEntry): void {
    if (this.serverKeeps) {
      this.send(toolLogEvent(entry));
      return;
    }
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** Send every entry of the local file through the outbox, then delete it. */
  private handOver(): number {
    if (!existsSync(this.path)) return 0;
    let sent = 0;
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (line.length === 0) continue;
      let entry: ToolLogEntry;
      try {
        entry = JSON.parse(line) as ToolLogEntry;
      } catch {
        continue; // A torn line: observability, not transactional state.
      }
      if (typeof entry.ts !== 'number' || typeof entry.tool !== 'string') continue;
      this.send(toolLogEvent(entry));
      sent += 1;
    }
    // The outbox has every entry on disk now, so the file can go.
    rmSync(this.path, { force: true });
    return sent;
  }
}
