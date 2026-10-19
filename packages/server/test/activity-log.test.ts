// Unit coverage for activity-log.ts — dwell-time reconstruction from raw
// focus/visibility events, window clamping, paging and persistence. Messages
// are not recorded here (they are read through each host's own chat log —
// see activity.test.ts).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityLog, computeChatSessions, ACTIVITY_RETENTION_MS } from '../src/activity-log.js';
import { ACTIVITY_MAX_WINDOW_MS } from '../src/activity.js';

describe('computeChatSessions', () => {
  it('opens a session when a surface is both focused and visible, closes it on either dropping', () => {
    const focus = [{ ts: 1_000, surfaceId: 's1', chatId: 'chatA' }];
    const visibility = [{ ts: 1_000, surfaceId: 's1', visible: true }];
    const sessions = computeChatSessions(focus, visibility, 1_000, 5_000);
    expect(sessions).toEqual([{ chatId: 'chatA', start: 1_000, end: 5_000, durationMs: 4_000 }]);
  });

  it('closes the session the instant visibility drops, even with focus unchanged', () => {
    const focus = [{ ts: 1_000, surfaceId: 's1', chatId: 'chatA' }];
    const visibility = [
      { ts: 1_000, surfaceId: 's1', visible: true },
      { ts: 3_000, surfaceId: 's1', visible: false },
    ];
    const sessions = computeChatSessions(focus, visibility, 1_000, 5_000);
    expect(sessions).toEqual([{ chatId: 'chatA', start: 1_000, end: 3_000, durationMs: 2_000 }]);
  });

  it('switching focus to another chat while visible closes the old session and opens a new one', () => {
    const focus = [
      { ts: 1_000, surfaceId: 's1', chatId: 'chatA' },
      { ts: 2_500, surfaceId: 's1', chatId: 'chatB' },
    ];
    const visibility = [{ ts: 1_000, surfaceId: 's1', visible: true }];
    const sessions = computeChatSessions(focus, visibility, 1_000, 4_000);
    expect(sessions).toEqual([
      { chatId: 'chatA', start: 1_000, end: 2_500, durationMs: 1_500 },
      { chatId: 'chatB', start: 2_500, end: 4_000, durationMs: 1_500 },
    ]);
  });

  it('focused but backgrounded does not count as open', () => {
    const focus = [{ ts: 1_000, surfaceId: 's1', chatId: 'chatA' }];
    const visibility = [{ ts: 1_000, surfaceId: 's1', visible: false }];
    const sessions = computeChatSessions(focus, visibility, 1_000, 5_000);
    expect(sessions).toEqual([]);
  });

  it('visible with no chat focused does not count as open', () => {
    const focus: Array<{ ts: number; surfaceId: string; chatId: string | null }> = [];
    const visibility = [{ ts: 1_000, surfaceId: 's1', visible: true }];
    const sessions = computeChatSessions(focus, visibility, 1_000, 5_000);
    expect(sessions).toEqual([]);
  });

  it('establishes state as of `since` from events before it, clipping the open session to the window start', () => {
    const focus = [{ ts: 100, surfaceId: 's1', chatId: 'chatA' }];
    const visibility = [{ ts: 100, surfaceId: 's1', visible: true }];
    // Both events are well before `since` — the chat was already open.
    const sessions = computeChatSessions(focus, visibility, 2_000, 5_000);
    expect(sessions).toEqual([{ chatId: 'chatA', start: 2_000, end: 5_000, durationMs: 3_000 }]);
  });

  it('two surfaces open on the same chat at once produce two rows, not one merged row', () => {
    const focus = [
      { ts: 1_000, surfaceId: 's1', chatId: 'chatA' },
      { ts: 1_500, surfaceId: 's2', chatId: 'chatA' },
    ];
    const visibility = [
      { ts: 1_000, surfaceId: 's1', visible: true },
      { ts: 1_500, surfaceId: 's2', visible: true },
    ];
    const sessions = computeChatSessions(focus, visibility, 1_000, 3_000).sort(
      (a, b) => a.start - b.start,
    );
    expect(sessions).toEqual([
      { chatId: 'chatA', start: 1_000, end: 3_000, durationMs: 2_000 },
      { chatId: 'chatA', start: 1_500, end: 3_000, durationMs: 1_500 },
    ]);
  });

  it('a chat unfocused (chatId: null) closes the session', () => {
    const focus = [
      { ts: 1_000, surfaceId: 's1', chatId: 'chatA' },
      { ts: 2_000, surfaceId: 's1', chatId: null },
    ];
    const visibility = [{ ts: 1_000, surfaceId: 's1', visible: true }];
    const sessions = computeChatSessions(focus, visibility, 1_000, 5_000);
    expect(sessions).toEqual([{ chatId: 'chatA', start: 1_000, end: 2_000, durationMs: 1_000 }]);
  });

  it('events outside the window are ignored', () => {
    const focus = [{ ts: 1_000, surfaceId: 's1', chatId: 'chatA' }];
    const visibility = [
      { ts: 1_000, surfaceId: 's1', visible: true },
      { ts: 9_000, surfaceId: 's1', visible: false }, // after `until`
    ];
    const sessions = computeChatSessions(focus, visibility, 1_000, 5_000);
    expect(sessions).toEqual([{ chatId: 'chatA', start: 1_000, end: 5_000, durationMs: 4_000 }]);
  });
});

describe('ActivityLog', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-activity-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('records and queries a dwell session end-to-end', () => {
    const log = new ActivityLog(dir, () => 10_000);
    log.recordFocus('s1', 'chatA', 1_000);
    log.recordVisibility('s1', true, 1_000);
    const result = log.querySessions({ since: 1_000, until: 5_000 });
    expect(result.chatSessions).toEqual([
      { chatId: 'chatA', start: 1_000, end: 5_000, durationMs: 4_000 },
    ]);
    expect(result.sessionsTruncated).toBe(false);
  });

  it('persists across reloads (JSONL round-trip)', () => {
    // Real-clock-relative timestamps: the constructor prunes anything older
    // than ACTIVITY_RETENTION_MS on load.
    const now = Date.now();
    const log = new ActivityLog(dir);
    log.recordFocus('s1', 'chatA', now - 1_000);
    log.recordVisibility('s1', true, now - 1_000);
    const reloaded = new ActivityLog(dir);
    const result = reloaded.querySessions({ since: now - 5_000, until: now });
    expect(result.chatSessions).toHaveLength(1);
    expect(result.chatSessions[0]).toMatchObject({ chatId: 'chatA', start: now - 1_000 });
  });

  it('drops events older than the retention on load, and compacts the file', () => {
    const now = 200 * 24 * 60 * 60 * 1000;
    writeFileSync(
      join(dir, 'activity.jsonl'),
      [
        { kind: 'focus', ts: now - ACTIVITY_RETENTION_MS - 1, surfaceId: 's1', chatId: 'old' },
        { kind: 'focus', ts: now - 1_000, surfaceId: 's1', chatId: 'new' },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n',
    );
    new ActivityLog(dir, () => now);
    const lines = readFileSync(join(dir, 'activity.jsonl'), 'utf8').trim().split('\n');
    expect(lines.map((l) => JSON.parse(l).chatId)).toEqual(['new']);
  });

  it('skips malformed lines instead of failing the load', () => {
    writeFileSync(
      join(dir, 'activity.jsonl'),
      `not json\n${JSON.stringify({ kind: 'focus', ts: Date.now(), surfaceId: 's1', chatId: 'a' })}\n`,
    );
    expect(() => new ActivityLog(dir)).not.toThrow();
  });

  it('clamps an over-long window to ACTIVITY_MAX_WINDOW_MS', () => {
    const until = 100 * 24 * 60 * 60 * 1000;
    const log = new ActivityLog(dir, () => until);
    log.recordFocus('s1', 'chatA', 1);
    log.recordVisibility('s1', true, 1);
    const result = log.querySessions({ since: 0, until });
    // The session opened at ts=1 is clipped to the clamped window start.
    expect(result.chatSessions[0]?.start).toBe(until - ACTIVITY_MAX_WINDOW_MS);
  });

  it('pages sessions with a resumable cursor', () => {
    const log = new ActivityLog(dir, () => 100_000);
    // Five separate visits to different chats on one surface.
    log.recordVisibility('s1', true, 1_000);
    for (let i = 0; i < 5; i++) log.recordFocus('s1', `chat${i}`, 1_000 + i * 100);

    const page1 = log.querySessions({ since: 1_000, until: 2_000, limit: 2 });
    expect(page1.chatSessions.map((s) => s.chatId)).toEqual(['chat0', 'chat1']);
    expect(page1.sessionsTruncated).toBe(true);
    expect(page1.nextSessionsCursor).toBe(1_101);

    const page2 = log.querySessions({
      since: 1_000,
      until: 2_000,
      limit: 2,
      sessionsCursor: page1.nextSessionsCursor,
    });
    expect(page2.chatSessions.map((s) => s.chatId)).toEqual(['chat2', 'chat3']);
    expect(page2.sessionsTruncated).toBe(true);

    const page3 = log.querySessions({
      since: 1_000,
      until: 2_000,
      limit: 2,
      sessionsCursor: page2.nextSessionsCursor,
    });
    expect(page3.chatSessions.map((s) => s.chatId)).toEqual(['chat4']);
    expect(page3.sessionsTruncated).toBe(false);
    expect(page3.nextSessionsCursor).toBeUndefined();
  });

  it('writes valid JSONL to disk', () => {
    const log = new ActivityLog(dir);
    log.recordFocus('s1', 'chatA', 1_000);
    const lines = readFileSync(join(dir, 'activity.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      kind: 'focus',
      ts: 1_000,
      surfaceId: 's1',
      chatId: 'chatA',
    });
  });
});
