// Read a message aloud with the browser's own speech synthesis (no server, no
// cost). One utterance plays at a time; starting another replaces it.
//
// "Read everything" is a per-device switch (localStorage): while on, each new
// settled assistant reply is spoken as it arrives. NO FALLBACK: a browser with
// no speech synthesis throws, and the caller surfaces it.

import { create } from 'zustand';

const READ_ALL_KEY = 'patch.readAll';

/** Markdown source to something worth hearing: no fences, link urls or marks. */
export function plainSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' code block. ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s+/g, ' ')
    .trim();
}

function synth(): SpeechSynthesis {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    throw new Error('This browser has no speech synthesis, so it cannot read aloud');
  }
  return window.speechSynthesis;
}

interface ReadAloudState {
  /** The key of the message being read, or null. */
  speaking: string | null;
  readAll: boolean;
  speak(key: string, markdown: string): void;
  stop(): void;
  setReadAll(on: boolean): void;
}

function loadReadAll(): boolean {
  try {
    return window.localStorage.getItem(READ_ALL_KEY) === '1';
  } catch {
    return false;
  }
}

export const useReadAloud = create<ReadAloudState>((set, get) => ({
  speaking: null,
  readAll: typeof window !== 'undefined' && loadReadAll(),
  speak(key, markdown) {
    const s = synth();
    const text = plainSpeech(markdown);
    if (text === '') throw new Error('Nothing to read in that message');
    s.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const done = (): void => {
      if (get().speaking === key) set({ speaking: null });
    };
    u.onend = done;
    u.onerror = (e) => {
      done();
      // A deliberate cancel (another message, or stop) is not a failure.
      if (e.error !== 'canceled' && e.error !== 'interrupted') {
        console.error('Read aloud failed', e.error);
      }
    };
    set({ speaking: key });
    s.speak(u);
  },
  stop() {
    synth().cancel();
    set({ speaking: null });
  },
  setReadAll(on) {
    window.localStorage.setItem(READ_ALL_KEY, on ? '1' : '0');
    if (!on && get().speaking !== null) get().stop();
    set({ readAll: on });
  },
}));
