// speechSetupStore — the first-meeting speech prompt (spec/02 § Speech set-up).
// Opened when a host refuses a meeting start with `speech_not_set_up`; it holds
// the chat that tried to start so the meeting can be started again once a route
// is chosen and working.

import { create } from 'zustand';

export interface SpeechSetupRequest {
  chatId: string;
  hostId: string;
}

interface SpeechSetupState {
  request: SpeechSetupRequest | null;
  open(request: SpeechSetupRequest): void;
  close(): void;
}

export const useSpeechSetupStore = create<SpeechSetupState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));
