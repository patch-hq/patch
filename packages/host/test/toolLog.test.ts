// ToolLogStore: the durable record behind Settings → Activity ("things agents
// did"). Append-only, bounded, read by window + limit — same contract as
// `packages/server/src/jobs/logs.ts`'s runs.jsonl.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolLogStore } from '../src/toolLog.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'patch-tool-log-store-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('ToolLogStore', () => {
  it('reads back what it appended, oldest first, capped at limit', () => {
    const store = new ToolLogStore(home);
    store.append({ ts: 1000, tool: 'patch_peek', durationMs: 1, ok: true });
    store.append({
      ts: 2000,
      tool: 'patch_send_to',
      callerChatId: 'c1',
      targetChatId: 'c2',
      durationMs: 2,
      ok: true,
    });
    store.append({ ts: 3000, tool: 'patch_spawn', durationMs: 3, ok: false, err: 'rate_limited' });

    expect(store.readEntries(0, 9999, 50)).toEqual([
      { ts: 1000, tool: 'patch_peek', durationMs: 1, ok: true },
      {
        ts: 2000,
        tool: 'patch_send_to',
        callerChatId: 'c1',
        targetChatId: 'c2',
        durationMs: 2,
        ok: true,
      },
      { ts: 3000, tool: 'patch_spawn', durationMs: 3, ok: false, err: 'rate_limited' },
    ]);
    expect(store.readEntries(1500, 9999, 50)).toEqual([
      {
        ts: 2000,
        tool: 'patch_send_to',
        callerChatId: 'c1',
        targetChatId: 'c2',
        durationMs: 2,
        ok: true,
      },
      { ts: 3000, tool: 'patch_spawn', durationMs: 3, ok: false, err: 'rate_limited' },
    ]);
    expect(store.readEntries(0, 9999, 1)).toEqual([
      { ts: 1000, tool: 'patch_peek', durationMs: 1, ok: true },
    ]);
  });

  it('returns nothing before the first append', () => {
    const store = new ToolLogStore(home);
    expect(store.readEntries(0, Date.now(), 50)).toEqual([]);
  });

  it('skips a malformed line rather than throwing', () => {
    const store = new ToolLogStore(home);
    store.append({ ts: 1000, tool: 'patch_peek', durationMs: 1, ok: true });
    const path = join(home, 'logs', 'tool-calls.jsonl');
    writeFileSync(path, `${readFileSync(path, 'utf8')}not json\n`);
    store.append({ ts: 2000, tool: 'patch_spawn', durationMs: 1, ok: true });
    expect(store.readEntries(0, 9999, 50).map((e) => e.ts)).toEqual([1000, 2000]);
  });

  it('trims to the newest keepEntries once the file passes the size cap', () => {
    // Small, injected thresholds so the trim triggers in a handful of
    // appends instead of the tens of thousands the real 2 MiB cap would take.
    const store = new ToolLogStore(home, { maxFileBytes: 200, keepEntries: 3 });
    for (let i = 0; i < 10; i++) {
      store.append({ ts: i, tool: 'patch_peek', durationMs: 1, ok: true });
    }
    const path = join(home, 'logs', 'tool-calls.jsonl');
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(3);
    const entries = store.readEntries(0, 10, 10);
    expect(entries.map((e) => e.ts)).toEqual([7, 8, 9]);
  });
});
