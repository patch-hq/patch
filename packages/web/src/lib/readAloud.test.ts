import { beforeEach, describe, expect, it, vi } from 'vitest';
import { plainSpeech, useReadAloud } from './readAloud.js';

class FakeUtterance {
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  constructor(public text: string) {}
}

describe('plainSpeech', () => {
  it('drops markdown furniture', () => {
    expect(plainSpeech('# Title\n\nSome **bold** and [a link](http://x.y) `code`.')).toBe(
      'Title. Some bold and a link code.',
    );
  });
  it('replaces fenced code', () => {
    expect(plainSpeech('a\n```js\nlet x=1\n```\nb')).toBe('a code block. b');
  });
});

describe('useReadAloud', () => {
  const speakFn = vi.fn();
  const cancelFn = vi.fn();
  beforeEach(() => {
    speakFn.mockReset();
    cancelFn.mockReset();
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    vi.stubGlobal('speechSynthesis', { speak: speakFn, cancel: cancelFn });
    Object.defineProperty(window, 'speechSynthesis', {
      value: { speak: speakFn, cancel: cancelFn },
      configurable: true,
    });
    useReadAloud.setState({ speaking: null, readAll: false });
  });

  it('speaks, then clears when the utterance ends', () => {
    useReadAloud.getState().speak('c:1', 'Hello there');
    expect(useReadAloud.getState().speaking).toBe('c:1');
    const u = speakFn.mock.calls[0]![0] as FakeUtterance;
    expect(u.text).toBe('Hello there');
    u.onend?.();
    expect(useReadAloud.getState().speaking).toBeNull();
  });

  it('stop cancels', () => {
    useReadAloud.getState().speak('c:1', 'Hello');
    useReadAloud.getState().stop();
    expect(cancelFn).toHaveBeenCalled();
    expect(useReadAloud.getState().speaking).toBeNull();
  });

  it('throws on empty text rather than staying silent', () => {
    expect(() => useReadAloud.getState().speak('c:1', '``` ```')).not.toThrow();
    expect(() => useReadAloud.getState().speak('c:2', '   ')).toThrow();
  });

  it('read-all persists and turning it off stops speech', () => {
    useReadAloud.getState().setReadAll(true);
    expect(window.localStorage.getItem('patch.readAll')).toBe('1');
    useReadAloud.getState().speak('c:1', 'Hi');
    useReadAloud.getState().setReadAll(false);
    expect(useReadAloud.getState().speaking).toBeNull();
    expect(window.localStorage.getItem('patch.readAll')).toBe('0');
  });
});
