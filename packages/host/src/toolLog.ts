// Cross-chat tool-call log — "things agents did" (Settings → Activity).
//
// Every `patch_*` cross-chat tool call reaches `control.ts`'s `toolLogger`
// hook, which sends it to the server as a `patch.tool_log.entry` through the
// host outbox (spec/01 § Host outbox). The server keeps the account's log, so
// it reads the same whether or not this host is online.
//
// Hosts used to keep their own `<patchHome>/logs/tool-calls.jsonl` and answer
// the server's reads of it. `importLegacyToolLog` hands what is left in that
// file to the outbox once, then removes it.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolLogEntry, WireEvent } from '@patch/wire';

/** The tool-log entry this host sends the server for one call. */
export function toolLogEvent(entry: ToolLogEntry): WireEvent {
  return { type: 'patch.tool_log.entry', entry };
}

/**
 * Send every entry of the old per-host log through `send` (the outbox, which
 * keeps each until the server acknowledges it), then delete the file. Returns
 * how many entries were handed over.
 */
export function importLegacyToolLog(patchHome: string, send: (event: WireEvent) => void): number {
  const path = join(patchHome, 'logs', 'tool-calls.jsonl');
  if (!existsSync(path)) return 0;
  let sent = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.length === 0) continue;
    let entry: ToolLogEntry;
    try {
      entry = JSON.parse(line) as ToolLogEntry;
    } catch {
      continue; // A torn line: observability, not transactional state.
    }
    if (typeof entry.ts !== 'number' || typeof entry.tool !== 'string') continue;
    send(toolLogEvent(entry));
    sent += 1;
  }
  rmSync(path, { force: true });
  return sent;
}
