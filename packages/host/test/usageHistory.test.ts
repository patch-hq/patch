// UsageHistoryStore + ChatTokenReader: what Settings → Usage charts and ranks.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatTokenReader, UsageHistoryStore, turnTokens } from '../src/usageHistory.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'patch-usage-history-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const sample = (ts: number, week: number) => ({ ts, accountId: 'a', label: 'Work', week });

describe('UsageHistoryStore', () => {
  it('reads back a window oldest first', () => {
    const s = new UsageHistoryStore(home);
    s.append(sample(3000, 0.3));
    s.append(sample(1000, 0.1));
    s.append(sample(2000, 0.2));
    expect(s.read(1500, 3000).map((x) => x.ts)).toEqual([2000, 3000]);
  });

  it('is empty before anything is written', () => {
    expect(new UsageHistoryStore(home).read(0, 10)).toEqual([]);
  });

  it('trims to the newest entries once past the size cap', () => {
    const s = new UsageHistoryStore(home, { maxFileBytes: 200, keepEntries: 2 });
    for (let i = 1; i <= 10; i++) s.append(sample(i * 1000, 0.1));
    expect(s.read(0, 99_999).map((x) => x.ts)).toEqual([9000, 10000]);
  });
});

function chat(id: string, name: string | undefined, turns: { at: number; usage: object }[]): void {
  const dir = join(home, 'chats', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'meta.json'),
    JSON.stringify(name ? { chatId: id, name } : { chatId: id }),
  );
  const lines = turns.map((t) =>
    JSON.stringify({
      v: 1,
      seq: 1,
      at: t.at,
      branchId: 'b',
      rec: { k: 'turn.end', outcome: 'completed', usage: t.usage },
    }),
  );
  lines.push(JSON.stringify({ v: 1, seq: 2, at: 1, branchId: 'b', rec: { k: 'log.start' } }));
  writeFileSync(join(dir, 'events.jsonl'), `${lines.join('\n')}\n`);
}

describe('ChatTokenReader', () => {
  it('sums input, cache and output tokens per chat within the window, biggest first', () => {
    chat('small', 'Small', [
      { at: 2000, usage: { input_tokens: 1, output_tokens: 9, totalCostUsd: 0.1 } },
    ]);
    chat('big', 'Big', [
      {
        at: 2000,
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 50,
          output_tokens: 8,
          totalCostUsd: 0.5,
        },
      },
      { at: 3000, usage: { input_tokens: 10, output_tokens: 10, totalCostUsd: 0.25 } },
      { at: 99_000, usage: { input_tokens: 5000, output_tokens: 0 } }, // outside the window
    ]);
    chat('old', undefined, [{ at: 10, usage: { input_tokens: 7 } }]);
    const r = new ChatTokenReader(join(home, 'chats')).read(1000, 4000);
    expect(r).toEqual([
      { chatId: 'big', name: 'Big', tokens: 180, costUsd: 0.75, turns: 2 },
      { chatId: 'small', name: 'Small', tokens: 10, costUsd: 0.1, turns: 1 },
    ]);
  });

  it('picks up a chat that has moved since the last read', () => {
    chat('c', 'C', [{ at: 2000, usage: { output_tokens: 5 } }]);
    const reader = new ChatTokenReader(join(home, 'chats'));
    expect(reader.read(0, 9999)[0]?.tokens).toBe(5);
    chat('c', 'C', [
      { at: 2000, usage: { output_tokens: 5 } },
      { at: 3000, usage: { output_tokens: 6 } },
    ]);
    expect(reader.read(0, 9999)[0]?.tokens).toBe(11);
  });

  it('turnTokens ignores missing and non-numeric fields', () => {
    expect(turnTokens({ input_tokens: 'x', output_tokens: 4 })).toBe(4);
  });
});
