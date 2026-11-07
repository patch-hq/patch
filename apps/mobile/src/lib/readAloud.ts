// Read a message aloud with the phone's own text-to-speech (expo-speech, no
// server, no cost). One utterance plays at a time; starting another replaces it.
//
// "Read everything" is a per-device switch (MMKV): while on, each new settled
// assistant reply is spoken as it arrives. NO FALLBACK: a failed utterance
// reaches the error toast.

import * as Speech from 'expo-speech';
import { create } from 'zustand';
import { store } from './credential';
import { useUiStore } from '../stores/uiStore';

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

interface ReadAloudState {
  /** The key of the message being read, or null. */
  speaking: string | null;
  readAll: boolean;
  speak(key: string, markdown: string): void;
  stop(): void;
  setReadAll(on: boolean): void;
}

export const useReadAloud = create<ReadAloudState>((set, get) => ({
  speaking: null,
  readAll: store().getBoolean(READ_ALL_KEY) === true,
  speak(key, markdown) {
    const text = plainSpeech(markdown);
    if (text === '') throw new Error('Nothing to read in that message');
    const done = (): void => {
      if (get().speaking === key) set({ speaking: null });
    };
    // A new utterance replaces the playing one; expo-speech queues otherwise.
    void Speech.stop();
    set({ speaking: key });
    Speech.speak(text, {
      language: 'en-GB',
      onDone: done,
      onStopped: done,
      onError: (e) => {
        done();
        useUiStore.getState().pushError(`read aloud failed: ${e.message}`);
      },
    });
  },
  stop() {
    void Speech.stop();
    set({ speaking: null });
  },
  setReadAll(on) {
    store().set(READ_ALL_KEY, on);
    if (!on && get().speaking !== null) get().stop();
    set({ readAll: on });
  },
}));

/** Speak, surfacing a thrown failure as an error toast. */
export function speakOrToast(key: string, markdown: string): void {
  try {
    useReadAloud.getState().speak(key, markdown);
  } catch (e) {
    useUiStore.getState().pushError(`read aloud failed: ${(e as Error).message}`);
  }
}
