// readUserMessages: user messages straight from the chats' events.jsonl.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUserMessages } from '../src/userMessages.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'patch-user-messages-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const msg = (
  chatId: string,
  role: string,
  content: string,
  createdAt: number,
  // spec/06 § patch_activity — the same flags `chatRunner.ts` persists for a
  // job fire / hook resubmit / goal resubmit / host-started turn.
  extra?: Record<string, unknown>,
) =>
  JSON.stringify({
    v: 1,
    seq: 0,
    at: createdAt,
    branchId: `${chatId}-b0`,
    rec: {
      k: 'event',
      event: { type: 'chat.message', chatId, role, content, seq: 0, createdAt, ...extra },
    },
  });

function writeLog(chatId: string, lines: string[], mtime?: number): void {
  mkdirSync(join(root, chatId), { recursive: true });
  const p = join(root, chatId, 'events.jsonl');
  writeFileSync(p, lines.join('\n') + '\n');
  if (mtime !== undefined) utimesSync(p, mtime / 1000, mtime / 1000);
}

describe('readUserMessages', () => {
  it('returns only user chat.messages inside the window, oldest first across chats', () => {
    writeLog('c1', [
      msg('c1', 'user', 'late', 5000),
      msg('c1', 'assistant', 'reply', 4000),
      msg('c1', 'user', 'too early', 100),
    ]);
    writeLog('c2', [msg('c2', 'user', 'middle', 3000), msg('c2', 'system', 'note', 3100)]);
    expect(readUserMessages(root, 1000, 9000, 10)).toEqual([
      { chatId: 'c2', text: 'middle', ts: 3000 },
      { chatId: 'c1', text: 'late', ts: 5000 },
    ]);
  });

  it('applies the limit to the oldest rows', () => {
    writeLog('c1', [
      msg('c1', 'user', 'a', 1000),
      msg('c1', 'user', 'b', 2000),
      msg('c1', 'user', 'c', 3000),
    ]);
    expect(readUserMessages(root, 0, 9000, 2).map((m) => m.text)).toEqual(['a', 'b']);
  });

  it('reports a message a log holds twice once, and skips a torn last line', () => {
    writeLog('c1', [
      msg('c1', 'user', 'dup', 2000),
      msg('c1', 'user', 'dup', 2000),
      '{"rec":{"k":"ev"',
    ]);
    expect(readUserMessages(root, 0, 9000, 10)).toEqual([{ chatId: 'c1', text: 'dup', ts: 2000 }]);
  });

  it('skips a chat whose log was last written before the window, and a chat with no log', () => {
    writeLog('old', [msg('old', 'user', 'ancient', 2000)], 1500);
    mkdirSync(join(root, 'empty'));
    expect(readUserMessages(root, 2000, 9000, 10)).toEqual([]);
  });
  it('keeps a multibyte character that straddles a read-chunk boundary', () => {
    const CHUNK = 256 * 1024;
    const text = (pad: number): string => `${'a'.repeat(pad)}€ and more`;
    const euro = Buffer.from('€');
    // Pad the line so the 3-byte "€" starts one byte before the chunk boundary.
    const pad = CHUNK - 1 - Buffer.from(msg('c1', 'user', text(0), 5000)).indexOf(euro);
    expect(Buffer.from(msg('c1', 'user', text(pad), 5000)).indexOf(euro)).toBe(CHUNK - 1);
    writeLog('c1', [msg('c1', 'user', text(pad), 5000)]);
    expect(readUserMessages(root, 0, 9000, 10)).toEqual([
      { chatId: 'c1', text: text(pad), ts: 5000 },
    ]);
  });

  it("classifies kind off the turn's own trigger/origin flags, omitting it for a plain user turn", () => {
    writeLog('c1', [
      msg('c1', 'user', 'plain', 1000),
      msg('c1', 'user', 'job fire', 2000, { jobTrigger: true }),
      msg('c1', 'user', 'hook resubmit', 3000, {
        hookTrigger: { hooks: [{ hookId: 'h1', hookName: 'checker' }] },
      }),
      msg('c1', 'user', 'goal resubmit', 4000, { goalTrigger: { reason: 'not yet' } }),
      msg('c1', 'user', 'Checking in — still working?', 5000, { origin: 'machine' }),
    ]);
    expect(readUserMessages(root, 0, 9000, 10)).toEqual([
      { chatId: 'c1', text: 'plain', ts: 1000 },
      { chatId: 'c1', text: 'job fire', ts: 2000, kind: 'job' },
      { chatId: 'c1', text: 'hook resubmit', ts: 3000, kind: 'hook' },
      { chatId: 'c1', text: 'goal resubmit', ts: 4000, kind: 'goal' },
      { chatId: 'c1', text: 'Checking in — still working?', ts: 5000, kind: 'machine' },
    ]);
  });

  it("reports a restart-resume 'Carry on' as host even though it keeps the turn's own origin", () => {
    writeLog('c1', [
      msg('c1', 'user', 'Carry on', 1000, {
        retryOfSeq: 0,
        systemContext: [{ source: 'patch', label: 'Turn interrupted by restart', text: 'x' }],
      }),
      msg('c1', 'user', 'typed', 2000, {
        systemContext: [{ source: 'x', label: 'Other', text: 'y' }],
      }),
    ]);
    expect(readUserMessages(root, 0, 9000, 10)).toEqual([
      { chatId: 'c1', text: 'Carry on', ts: 1000, kind: 'machine' },
      { chatId: 'c1', text: 'typed', ts: 2000 },
    ]);
  });

  it('a goal/hook resubmit that also carries origin: host is reported by the more specific kind', () => {
    writeLog('c1', [
      msg('c1', 'user', 'goal resubmit', 1000, {
        goalTrigger: { reason: 'not yet' },
        origin: 'machine',
      }),
    ]);
    expect(readUserMessages(root, 0, 9000, 10)).toEqual([
      { chatId: 'c1', text: 'goal resubmit', ts: 1000, kind: 'goal' },
    ]);
  });
});
