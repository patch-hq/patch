// lib/transcriptCache.ts — the on-phone mirror of each chat's durable events.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __clearAllMmkv } from './stubs/mmkv';
import {
  MAX_CACHED_CHATS,
  __resetPendingForTests,
  heldCursor,
  loadTranscript,
  markSynced,
  needsOfflineSync,
  pruneTranscripts,
  saveEvents,
  saveResolution,
} from '../src/lib/transcriptCache';

const ev = (chatId: string, seq: number): unknown => ({
  type: 'chat.message',
  chatId,
  seq,
  role: 'assistant',
  content: `m${seq}`,
});

/** Save and let the coalescing timer write it out. */
function save(chatId: string, ...seqs: number[]): void {
  saveEvents(
    chatId,
    seqs.map((s) => ev(chatId, s)),
  );
  vi.advanceTimersByTime(1000);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  __clearAllMmkv();
  __resetPendingForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('transcriptCache', () => {
  it('keeps the answer to a cached question, which carries no seq, across a restart', () => {
    saveEvents('q', [{ type: 'chat.permission_request', chatId: 'q', seq: 645, requestId: 'r1' }]);
    vi.advanceTimersByTime(1000);
    saveResolution('q', 'r1', 'approve', { Library: 'Luxon' });
    saveResolution('q', 'r1', 'approve', { Library: 'Luxon' });
    __resetPendingForTests();
    expect(loadTranscript('q')!.resolutions).toEqual({
      r1: [{ decision: 'approve', answers: { Library: 'Luxon' } }],
    });
  });

  it('writes an answer that lands before its request was flushed', () => {
    saveEvents('q2', [{ type: 'chat.permission_request', chatId: 'q2', seq: 1, requestId: 'r' }]);
    saveResolution('q2', 'r', 'deny');
    expect(loadTranscript('q2')!.resolutions).toEqual({ r: [{ decision: 'deny' }] });
  });

  it('ignores an answer for a chat it holds nothing for', () => {
    saveResolution('nobody', 'r', 'approve');
    expect(loadTranscript('nobody')).toBeNull();
  });

  it('holds what was saved, oldest first, without duplicating a re-delivery', () => {
    save('a', 1, 2, 3);
    save('a', 3, 4);
    expect((loadTranscript('a')!.events as { seq: number }[]).map((e) => e.seq)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('keeps only the most recently used chats', () => {
    for (let i = 0; i < MAX_CACHED_CHATS + 1; i++) {
      vi.advanceTimersByTime(10_000);
      save(`c${i}`, 1);
    }
    expect(loadTranscript('c0')).toBeNull();
    expect(loadTranscript('c1')).not.toBeNull();
  });

  it('a chat that is receiving live events is recent: it is not the one evicted', () => {
    for (let i = 0; i < MAX_CACHED_CHATS; i++) {
      vi.advanceTimersByTime(10_000);
      save(`c${i}`, 1, 2);
    }
    // c0 is the least recently OPENED, but a live event lands for it in the
    // same flush that a brand-new chat arrives.
    vi.advanceTimersByTime(10_000);
    saveEvents('c0', [ev('c0', 3)]);
    saveEvents('new', [ev('new', 1)]);
    vi.advanceTimersByTime(1000);

    const c0 = loadTranscript('c0');
    expect(c0).not.toBeNull();
    expect((c0!.events as { seq: number }[]).map((e) => e.seq)).toEqual([1, 2, 3]);
    // The chat nobody touched is the one that went.
    expect(loadTranscript('c1')).toBeNull();
  });

  it('reports the held cursor without bumping recency, -1 for an unheld chat', () => {
    expect(heldCursor('none')).toBe(-1);
    save('h', 0, 1, 4);
    expect(heldCursor('h')).toBe(4);
  });

  it('needs a sync until marked at the roster lastUpdated, then again when it moves', () => {
    expect(needsOfflineSync('s', 10)).toBe(true);
    save('s', 0, 1);
    expect(needsOfflineSync('s', 10)).toBe(true);
    markSynced('s', 10);
    expect(needsOfflineSync('s', 10)).toBe(false);
    expect(needsOfflineSync('s', 11)).toBe(true);
  });

  it('prunes chats the roster no longer lists', () => {
    save('keep', 0);
    save('drop', 0);
    markSynced('drop', 1);
    pruneTranscripts(new Set(['keep']));
    expect(loadTranscript('drop')).toBeNull();
    expect(loadTranscript('keep')).not.toBeNull();
    expect(needsOfflineSync('drop', 1)).toBe(true);
  });
});
