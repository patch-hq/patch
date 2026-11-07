import { beforeEach, describe, expect, it } from 'vitest';
import * as SpeechStub from '../__tests__/stubs/expo-speech';
import { plainSpeech, useReadAloud } from '../src/lib/readAloud';
import { freshReply, latestAssistantSeq } from '../src/lib/readEverything';
import { chatKebabItems } from '../src/lib/chatActions';
import { useUiStore } from '../src/stores/uiStore';
import type { ChatEventEntry } from '../src/stores/chatStore';

const speech = SpeechStub as unknown as typeof SpeechStub;

function msg(seq: number, over: Partial<ChatEventEntry> = {}): ChatEventEntry {
  return { seq, kind: 'message', role: 'assistant', content: `m${seq}`, ...over } as ChatEventEntry;
}

beforeEach(() => {
  speech.__resetSpeech();
  useReadAloud.setState({ speaking: null, readAll: false });
});

describe('plainSpeech', () => {
  it('drops markup and code', () => {
    expect(plainSpeech('# Hi\n\n**bold** [link](http://x) `c`\n\n```\ncode\n```')).toBe(
      'Hi. bold link c. code block.',
    );
  });
});

describe('useReadAloud', () => {
  it('speaks, marks the message playing, and clears on done', () => {
    useReadAloud.getState().speak('a:1', 'hello');
    expect(speech.__spoken()).toEqual(['hello']);
    expect(useReadAloud.getState().speaking).toBe('a:1');
    speech.__finish();
    expect(useReadAloud.getState().speaking).toBeNull();
  });
  it('throws on empty text', () => {
    expect(() => useReadAloud.getState().speak('a:1', '  ')).toThrow();
  });
  it('stop clears playing', () => {
    useReadAloud.getState().speak('a:1', 'hello');
    useReadAloud.getState().stop();
    expect(useReadAloud.getState().speaking).toBeNull();
  });
  it('an utterance error surfaces as a toast, not silence', () => {
    useReadAloud.getState().speak('a:1', 'hello');
    speech.__error('no engine');
    expect(useReadAloud.getState().speaking).toBeNull();
    expect(JSON.stringify(useUiStore.getState())).toContain('read aloud failed: no engine');
  });
  it('read-all turning off stops playback and persists', () => {
    useReadAloud.getState().setReadAll(true);
    useReadAloud.getState().speak('a:1', 'hello');
    useReadAloud.getState().setReadAll(false);
    expect(useReadAloud.getState().speaking).toBeNull();
    expect(useReadAloud.getState().readAll).toBe(false);
  });
});

describe('freshReply', () => {
  const now = 1_000_000;
  it('picks only settled, new, recent assistant replies', () => {
    const tl = [
      msg(1, { messageAt: now - 1000 }),
      msg(3, { messageAt: now - 120_000 }),
      msg(4, { messageAt: now - 1000, role: 'user' }),
      msg(5, { messageAt: now - 1000 }),
    ];
    expect(freshReply(tl, 1, now)?.seq).toBe(5);
    expect(freshReply(tl, 5, now)).toBeUndefined();
  });
  it('latestAssistantSeq is the newest assistant seq', () => {
    expect(latestAssistantSeq([msg(1), msg(2), msg(3, { role: 'user' })])).toBe(2);
  });
});

describe('kebab', () => {
  it('offers read-everything and its off state', () => {
    expect(
      chatKebabItems('01HXREGULAR', {
        pinned: false,
        snoozed: false,
        archived: false,
        hidden: false,
        disabled: false,
      }),
    ).toContain('Read everything aloud');
    expect(
      chatKebabItems('01HXREGULAR', {
        pinned: false,
        snoozed: false,
        archived: false,
        hidden: false,
        disabled: false,
        readAll: true,
      }),
    ).toContain('Stop reading everything');
  });
});
