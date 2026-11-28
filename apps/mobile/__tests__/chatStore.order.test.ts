// spec/07 § Voice replies in the chat, spec/14 and 15 — a message's place is
// its seq, whenever it arrives, and a spoken reply is one message at its seq
// that later writes change in place.

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../src/stores/chatStore';

const say = (role: 'user' | 'assistant', seq: number, content: string) =>
  useChatStore.getState().applyEvent({ type: 'chat.message', chatId: 'c1', role, content, seq });
const rows = () =>
  (useChatStore.getState().timelines['c1'] ?? [])
    .filter((e) => e.kind === 'message')
    .map((e) => [e.seq, e.content]);

beforeEach(() => useChatStore.getState()._reset());

describe('chatStore — order is the seq', () => {
  it('a reply that finishes after a later agent message keeps its own seq and place', () => {
    say('user', 1, 'hi');
    say('assistant', 2, '[voice • web] first words');
    say('assistant', 3, 'agent message');
    say('assistant', 2, '[voice • web] first words and the rest');
    expect(rows()).toEqual([
      [1, 'hi'],
      [2, 'first words and the rest'],
      [3, 'agent message'],
    ]);
  });

  it('an older message arriving late is placed by its seq', () => {
    say('assistant', 5, 'e');
    say('assistant', 3, 'c');
    say('assistant', 4, 'd');
    expect(rows().map((r) => r[0])).toEqual([3, 4, 5]);
  });

  it('a cut changes the same message in place with the cut mark and adds none', () => {
    say('user', 1, 'tell me a story');
    say('assistant', 2, '[voice • web] Once upon a time there was a very long story.');
    say('assistant', 3, 'agent message');
    say('assistant', 2, '[voice • web] Once upon a time…');
    expect(rows()).toEqual([
      [1, 'tell me a story'],
      [2, 'Once upon a time…'],
      [3, 'agent message'],
    ]);
  });

  it('paragraph breaks in a reply survive', () => {
    say('assistant', 2, '[voice • web] One.\n\nTwo.');
    expect(rows()).toEqual([[2, 'One.\n\nTwo.']]);
  });
});
