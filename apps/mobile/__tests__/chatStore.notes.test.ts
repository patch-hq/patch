// spec/04 § Notes to the agent — a note is its own entry in the phone's
// timeline, ahead of the message it went with, drawn once however many times a
// replay re-delivers it.

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../src/stores/chatStore';

beforeEach(() => {
  useChatStore.getState()._reset();
});

describe('chat.note on the phone', () => {
  it('keeps each note as its own entry before the message, once across a replay', () => {
    const { applyEvent } = useChatStore.getState();
    const note = {
      type: 'chat.note',
      chatId: 'c1',
      seq: 1,
      label: 'Hook advice',
      text: 'The tone check said a little terse.',
    } as const;
    applyEvent(note);
    applyEvent({ type: 'chat.message', chatId: 'c1', role: 'user', content: 'thanks', seq: 2 });
    applyEvent(note);
    const list = useChatStore.getState().timelines['c1'] ?? [];
    expect(list.map((e) => [e.kind, e.seq])).toEqual([
      ['note', 1],
      ['message', 2],
    ]);
    expect(list[0]).toMatchObject({
      noteLabel: 'Hook advice',
      content: 'The tone check said a little terse.',
    });
    expect(list[1]).not.toHaveProperty('systemContext');
    expect(useChatStore.getState().chats['c1']?.lastSeq).toBe(2);
  });
});
