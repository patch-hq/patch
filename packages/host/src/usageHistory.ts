// Settings → Usage — the two things the page charts that nothing kept before.
//
//   <patchHome>/logs/usage-history.jsonl   one line per account probe
//   <patchHome>/chats/<id>/events.jsonl    each chat's own `turn.end` records
//
// The probe reading (accountUsage.ts) is a statement about right now and lives
// in memory, so "how did the week's allowance go down" had no answer. Each
// probe is now also appended here, bounded the same way as tool-log.
//
// Per-chat tokens are not stored anywhere new: they are summed out of the
// chats' own logs, which already carry every turn's `usage`. A chat's total is
// cached against its log file's size+mtime, so a repeat read only re-scans
// chats that have moved.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ChatTokenUsage, UsageSample } from '@patch/wire';

export const USAGE_HISTORY_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const USAGE_HISTORY_KEEP_ENTRIES = 20_000;

export class UsageHistoryStore {
  private readonly path: string;

  constructor(
    patchHome: string,
    private readonly opts: { maxFileBytes?: number; keepEntries?: number } = {},
  ) {
    const dir = join(patchHome, 'logs');
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, 'usage-history.jsonl');
  }

  append(sample: UsageSample): void {
    appendFileSync(this.path, `${JSON.stringify(sample)}\n`);
    if (statSync(this.path).size > (this.opts.maxFileBytes ?? USAGE_HISTORY_MAX_FILE_BYTES)) {
      const lines = readFileSync(this.path, 'utf8')
        .split('\n')
        .filter((l) => l !== '');
      const kept = lines.slice(-(this.opts.keepEntries ?? USAGE_HISTORY_KEEP_ENTRIES));
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, `${kept.join('\n')}\n`);
      renameSync(tmp, this.path);
    }
  }

  /** Samples in [since, until], oldest first. A corrupt line fails loudly. */
  read(since: number, until: number): UsageSample[] {
    if (!existsSync(this.path)) return [];
    const out: UsageSample[] = [];
    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (line === '') continue;
      const s = JSON.parse(line) as UsageSample;
      if (s.ts >= since && s.ts <= until) out.push(s);
    }
    return out.sort((a, b) => a.ts - b.ts);
  }
}

interface TurnTotals {
  at: number;
  tokens: number;
  costUsd: number;
}

/** Every token a turn processed or produced: fresh + cached input, and output. */
export function turnTokens(usage: Record<string, unknown>): number {
  const n = (k: string): number => (typeof usage[k] === 'number' ? (usage[k] as number) : 0);
  return (
    n('input_tokens') +
    n('cache_creation_input_tokens') +
    n('cache_read_input_tokens') +
    n('output_tokens')
  );
}

interface CachedChat {
  size: number;
  mtimeMs: number;
  turns: TurnTotals[];
}

export class ChatTokenReader {
  private readonly cache = new Map<string, CachedChat>();

  constructor(private readonly chatsDir: string) {}

  /** Chats with at least one completed turn in [since, until], biggest first. */
  read(since: number, until: number): ChatTokenUsage[] {
    if (!existsSync(this.chatsDir)) return [];
    const out: ChatTokenUsage[] = [];
    for (const chatId of readdirSync(this.chatsDir)) {
      const log = join(this.chatsDir, chatId, 'events.jsonl');
      let st;
      try {
        st = statSync(log);
      } catch {
        continue; // a chat with no log has had no turns
      }
      // A log last written before the window cannot hold a turn inside it.
      if (st.mtimeMs < since) continue;
      let entry = this.cache.get(chatId);
      if (!entry || entry.size !== st.size || entry.mtimeMs !== st.mtimeMs) {
        entry = { size: st.size, mtimeMs: st.mtimeMs, turns: scanTurns(log) };
        this.cache.set(chatId, entry);
      }
      let tokens = 0;
      let costUsd = 0;
      let turns = 0;
      for (const t of entry.turns) {
        if (t.at < since || t.at > until) continue;
        tokens += t.tokens;
        costUsd += t.costUsd;
        turns += 1;
      }
      if (turns === 0) continue;
      const name = readName(join(this.chatsDir, chatId, 'meta.json'));
      out.push({ chatId, ...(name !== undefined ? { name } : {}), tokens, costUsd, turns });
    }
    return out.sort((a, b) => b.tokens - a.tokens);
  }
}

function scanTurns(log: string): TurnTotals[] {
  const turns: TurnTotals[] = [];
  for (const line of readFileSync(log, 'utf8').split('\n')) {
    // Cheap filter first: most lines are not turn ends, and parsing them all
    // across thousands of chats is the cost this avoids.
    if (!line.includes('"k":"turn.end"')) continue;
    let rec: { at?: number; rec?: { usage?: Record<string, unknown> } };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue; // a torn last line; ChatLog repairs it on open
    }
    const usage = rec.rec?.usage;
    if (!usage || typeof rec.at !== 'number') continue;
    turns.push({
      at: rec.at,
      tokens: turnTokens(usage),
      costUsd: typeof usage['totalCostUsd'] === 'number' ? (usage['totalCostUsd'] as number) : 0,
    });
  }
  return turns;
}

function readName(metaPath: string): string | undefined {
  try {
    const m = JSON.parse(readFileSync(metaPath, 'utf8')) as { name?: unknown };
    return typeof m.name === 'string' && m.name !== '' ? m.name : undefined;
  } catch {
    return undefined;
  }
}
