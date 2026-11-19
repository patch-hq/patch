// inboxStore — the Inbox cards (experimental). A card is either a question an
// agent put to the user (a short prompt with options) or a report a job
// produced. It stays until the user ticks it off. UI-first pass: the store is
// local; the server-backed feed is the next step once the design is approved.

import { create } from 'zustand';

export type InboxCard =
  | {
      kind: 'question';
      id: string;
      from: string;
      at: number;
      prompt: string;
      options: string[];
      /** The option a bare tap on Enter picks; the first by default (yes/no → yes). */
      defaultOption: string;
      answer?: string;
      done: boolean;
    }
  | {
      kind: 'report';
      id: string;
      from: string;
      at: number;
      title: string;
      body: string;
      done: boolean;
    };

interface InboxState {
  cards: InboxCard[];
  set(cards: InboxCard[]): void;
  answer(id: string, option: string): void;
  tick(id: string): void;
}

export const useInboxStore = create<InboxState>((set) => ({
  cards: [],
  set: (cards) => set({ cards }),
  answer: (id, option) =>
    set((s) => ({
      cards: s.cards.map((c) =>
        c.id === id && c.kind === 'question' ? { ...c, answer: option, done: true } : c,
      ),
    })),
  tick: (id) =>
    set((s) => ({ cards: s.cards.map((c) => (c.id === id ? { ...c, done: true } : c)) })),
}));
