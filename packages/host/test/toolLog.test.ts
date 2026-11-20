// The host's half of the tool log (Settings → Activity): each call goes to the
// server as a `patch.tool_log.entry` through the outbox, and the per-host file
// older hosts kept is handed over once, then removed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isOutboxEvent, type WireEvent } from '@patch/wire';
import { importLegacyToolLog, toolLogEvent } from '../src/toolLog.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'patch-tool-log-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('toolLogEvent', () => {
  it('wraps an entry in a frame the outbox keeps', () => {
    const event = toolLogEvent({ ts: 1, tool: 'patch_peek', durationMs: 2, ok: true });
    expect(event).toEqual({
      type: 'patch.tool_log.entry',
      entry: { ts: 1, tool: 'patch_peek', durationMs: 2, ok: true },
    });
    expect(isOutboxEvent(event)).toBe(true);
  });
});

describe('importLegacyToolLog', () => {
  it('sends every entry of the old file, skipping torn lines, then deletes it', () => {
    const dir = join(home, 'logs');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'tool-calls.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify({ ts: 1000, tool: 'patch_peek', durationMs: 1, ok: true }),
        '{"torn',
        JSON.stringify({
          ts: 2000,
          tool: 'patch_send_to',
          callerChatId: 'c1',
          targetChatId: 'c2',
          durationMs: 2,
          ok: false,
          err: 'chat_not_found',
        }),
        '',
      ].join('\n'),
    );
    const sent: WireEvent[] = [];
    expect(importLegacyToolLog(home, (e) => sent.push(e))).toBe(2);
    expect(sent.map((e) => (e as { entry: { ts: number } }).entry.ts)).toEqual([1000, 2000]);
    expect(existsSync(path)).toBe(false);
  });

  it('does nothing when there is no old file', () => {
    const sent: WireEvent[] = [];
    expect(importLegacyToolLog(home, (e) => sent.push(e))).toBe(0);
    expect(sent).toEqual([]);
  });
});
