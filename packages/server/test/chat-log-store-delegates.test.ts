// A `patch_agent` subagent's record (spec/02 § Native subagent dispatch): kept
// in its own file against its parent, readable after a restart, and never
// counted as the user's own messages.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WireEvent } from '@patch/wire';
import { ChatLogStore } from '../src/chat-log-store.js';

const logger = { warn: () => undefined };
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patch-delegate-record-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const userMsg = (chatId: string, seq: number, ts: number): WireEvent =>
  ({
    type: 'chat.message',
    chatId,
    role: 'user',
    content: `u${seq}`,
    seq,
    createdAt: ts,
  }) as WireEvent;

describe('ChatLogStore subagent records', () => {
  it('keeps the parent link on disk, said once', () => {
    const store = new ChatLogStore({ dataDir: dir, logger });
    store.noteParent('sub-1', 'parent-1');
    store.noteParent('sub-1', 'parent-1');
    store.commit(userMsg('sub-1', 0, 1000));
    expect(store.parentOf('sub-1')).toBe('parent-1');
    expect(store.parentOf('parent-1')).toBeUndefined();
    const again = new ChatLogStore({ dataDir: dir, logger });
    expect(again.parentOf('sub-1')).toBe('parent-1');
    expect(again.read('sub-1', -1)).toHaveLength(1);
  });

  it('leaves a subagent’s turns out of the user’s own messages, on disk and in memory', () => {
    for (const store of [
      new ChatLogStore({ dataDir: dir, logger }),
      new ChatLogStore({ logger }),
    ]) {
      store.commit(userMsg('c1', 0, 1000));
      store.noteParent('sub-1', 'c1');
      store.commit(userMsg('sub-1', 0, 1001));
      expect(store.userMessages(0, 5000).map((m) => m.chatId)).toEqual(['c1']);
    }
  });
});
