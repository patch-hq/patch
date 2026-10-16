// lib/transcriptCache.ts — the on-phone mirror of each chat's durable events.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __clearAllMmkv } from './stubs/mmkv';
import {
  MAX_CACHED_CHATS,
  __resetPendingForTests,
  loadTranscript,
  saveEvents,
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
});
