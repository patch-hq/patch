// Parked decisions per chat (spec/14 — Decisions). Held apart from ChatRow so
// the panel can be built and reviewed before the host feeds it; once the wire
// event lands, the host's list replaces what is set here.

import { create } from 'zustand';
import type { ChatDecision } from './types.js';

interface DecisionsState {
  byChat: Record<string, ChatDecision[]>;
  set(chatId: string, decisions: ChatDecision[]): void;
}

export const useDecisionsStore = create<DecisionsState>((set, get) => ({
  byChat: {},
  set(chatId, decisions) {
    set({ byChat: { ...get().byChat, [chatId]: decisions } });
  },
}));
