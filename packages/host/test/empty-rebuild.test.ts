// A native rebuild whose track holds only a prompt and a limit notice has no
// answered turn: the reseeded session is one Claude Code refuses to resume
// ("No conversation found"). chatRunner probes the reconstruction the same way
// and starts a fresh session instead.

import { describe, it, expect } from 'vitest';
import type { LoggedEvent } from '@patch/wire';
import { hasConversation, stripSyntheticTurns } from '../src/syntheticTurns.js';
import { toClaudeSessionEntries, type TrackEntry } from '../src/nativeReconstruct.js';

const hasAnswer = (events: LoggedEvent[]): boolean =>
  hasConversation(
    stripSyntheticTurns(
      toClaudeSessionEntries(
        events.map((event, i): TrackEntry => ({ record: { seq: i, at: 1000 + i }, event })),
        { sessionId: 's', folder: '/f', model: null },
      ) as unknown as Parameters<typeof stripSyntheticTurns>[0],
    ).entries,
  );

describe('empty native rebuild', () => {
  it('a prompt and a limit notice have no answered turn', () => {
    expect(
      hasAnswer([
        { type: 'chat.message', chatId: 'c', role: 'user', content: 'do it', seq: 0 },
        { type: 'chat.message', chatId: 'c', role: 'system', content: 'out of credit', seq: 1 },
      ]),
    ).toBe(false);
  });
  it('a prompt that was answered does', () => {
    expect(
      hasAnswer([
        { type: 'chat.message', chatId: 'c', role: 'user', content: 'do it', seq: 0 },
        { type: 'chat.message', chatId: 'c', role: 'assistant', content: 'done', seq: 1 },
      ]),
    ).toBe(true);
  });
});
