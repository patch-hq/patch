// What the Codex adapter keeps about each of its threads, beside Codex's own
// store: where Codex saved the thread (so a resume finds it under whichever
// account wrote it), and the turn in flight when a process died (so a restart
// can tell a turn that ran from one that never started). No conversation
// content: what a chat shows comes from Patch's record (spec/04 § History).
//
// Files live under `<patch home>/openai-history` as `<sessionId>.jsonl.path`
// and `<sessionId>.jsonl.pending`, the names older hosts used, so existing
// threads still resume. Older hosts also wrote `<sessionId>.jsonl`, a copy of
// each thread's events; nothing reads or writes those any more.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionProbe } from './history.js';

export class CodexSessions implements SessionProbe {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  private path(id: string): string {
    if (!id.startsWith('codex-') || !/^[a-zA-Z0-9-]+$/.test(id))
      throw new Error('Invalid codex session id');
    return join(this.root, `${id}.jsonl`);
  }

  /** Record a thread Codex has started, resumed or forked, and where it saved it. */
  begin(id: string, providerPath?: string): void {
    writeFileSync(this.path(id) + '.path', providerPath ?? '', { mode: 0o600 });
  }

  /** Where Codex saved the thread, if it said. */
  providerPath(id: string): string | undefined {
    const path = this.path(id) + '.path';
    if (!existsSync(path)) return undefined;
    const value = readFileSync(path, 'utf8');
    return value.length > 0 ? value : undefined;
  }

  pending(id: string): { id: string; prompt: string } | null {
    const path = this.path(id) + '.pending';
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  }

  setPending(id: string, value: { id: string; prompt: string } | null): void {
    const path = this.path(id) + '.pending';
    writeFileSync(path + '.new', JSON.stringify(value), { mode: 0o600, flush: true });
    renameSync(path + '.new', path);
  }

  hasSession(opts: { sessionId: string }): boolean {
    return existsSync(this.path(opts.sessionId) + '.path');
  }
}
