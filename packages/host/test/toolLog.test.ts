// The host's half of the tool log (Settings → Activity): entries stay in the
// host's own file until the server on the link keeps the log (`serverReads`),
// then that file is handed to the outbox once and new entries follow it there.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isOutboxEvent, type WireEvent } from '@patch/wire';
import { ToolLogSink, toolLogEvent } from '../src/toolLog.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'patch-tool-log-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const file = () => join(home, 'logs', 'tool-calls.jsonl');
const entry = (ts: number) => ({ ts, tool: 'patch_peek', durationMs: 1, ok: true });
const tsOf = (events: WireEvent[]) => events.map((e) => (e as { entry: { ts: number } }).entry.ts);

describe('toolLogEvent', () => {
  it('wraps an entry in a frame the outbox keeps', () => {
    const event = toolLogEvent(entry(1));
    expect(event).toEqual({ type: 'patch.tool_log.entry', entry: entry(1) });
    expect(isOutboxEvent(event)).toBe(true);
  });
});

describe('ToolLogSink', () => {
  it('writes locally until a server keeps the log, then hands the file over and sends new entries', () => {
    const sent: WireEvent[] = [];
    const sink = new ToolLogSink(home, (e) => sent.push(e));
    sink.append(entry(1));
    expect(sink.onServer(false)).toBe(0);
    sink.append(entry(2));
    expect(sent).toEqual([]);
    expect(readFileSync(file(), 'utf8').trim().split('\n')).toHaveLength(2);

    expect(sink.onServer(true)).toBe(2);
    expect(existsSync(file())).toBe(false);
    sink.append(entry(3));
    expect(tsOf(sent)).toEqual([1, 2, 3]);
  });

  it('hands over the file an older host left, skipping torn lines', () => {
    mkdirSync(join(home, 'logs'), { recursive: true });
    writeFileSync(file(), [JSON.stringify(entry(5)), '{"torn', ''].join('\n'));
    const sent: WireEvent[] = [];
    const sink = new ToolLogSink(home, (e) => sent.push(e));
    expect(sink.onServer(true)).toBe(1);
    expect(tsOf(sent)).toEqual([5]);
    expect(existsSync(file())).toBe(false);
  });

  it('goes back to the local file on a server that does not keep the log', () => {
    const sent: WireEvent[] = [];
    const sink = new ToolLogSink(home, (e) => sent.push(e));
    sink.onServer(true);
    sink.onServer(false);
    sink.append(entry(9));
    expect(sent).toEqual([]);
    expect(existsSync(file())).toBe(true);
  });
});
