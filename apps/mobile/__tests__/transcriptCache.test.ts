// lib/transcriptCache.ts — the on-phone mirror of each chat's durable events.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __clearAllMmkv } from './stubs/mmkv';
import { store } from '../src/lib/credential';
import {
  MAX_CACHED_CHATS,
  __resetPendingForTests,
  heldCursor,
  heldChatIds,
  loadTranscript,
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

  it('prunes chats the roster no longer lists', () => {
    save('keep', 0);
    save('drop', 0);
    pruneTranscripts(new Set(['keep']));
    expect(loadTranscript('drop')).toBeNull();
    expect(loadTranscript('keep')).not.toBeNull();
    expect([...heldChatIds()]).toEqual(['keep']);
  });

  it('a prune also drops events still waiting to be written for a pruned chat', () => {
    save('drop', 0);
    saveEvents('drop', [ev('drop', 1)]);
    pruneTranscripts(new Set());
    vi.advanceTimersByTime(1000);
    expect(loadTranscript('drop')).toBeNull();
  });

  it('a prune clears the sync marks an earlier build kept', () => {
    store().set('patch.transcript.synced.v1', JSON.stringify({ old: 1 }));
    pruneTranscripts(new Set());
    expect(store().getString('patch.transcript.synced.v1')).toBeUndefined();
  });
});

describe('heldCursor cost', () => {
  it('reads a stored cursor without parsing the transcript', () => {
    save('fast', 1, 2, 9);
    const parse = vi.spyOn(JSON, 'parse');
    expect(heldCursor('fast')).toBe(9);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it('derives the cursor once for a blob written before cursors were kept', async () => {
    const { store } = await import('../src/lib/credential');
    store().set(
      'patch.transcript.v1.legacy',
      JSON.stringify({
        branchId: null,
        events: [ev('legacy', 3), ev('legacy', 7)],
        resolutions: {},
      }),
    );
    expect(heldCursor('legacy')).toBe(7);
    const parse = vi.spyOn(JSON, 'parse');
    expect(heldCursor('legacy')).toBe(7);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it('forgets the cursor with the transcript', () => {
    save('gone', 4);
    pruneTranscripts(new Set());
    expect(heldCursor('gone')).toBe(-1);
  });
});
