// signInStore — new devices asking to sign in, waiting on an Allow / Deny from
// this (already signed-in) surface. The server owns the requests; this mirrors
// `signin.requested` / `signin.resolved` and the `pending` list.

import { create } from 'zustand';

export interface SignInRequestRow {
  id: string;
  label: string;
  expiresAt: number;
}

interface SignInStoreState {
  requests: SignInRequestRow[];
  add(request: SignInRequestRow): void;
  remove(id: string): void;
  reset(): void;
}

export const useSignInStore = create<SignInStoreState>((set) => ({
  requests: [],
  add: (request) =>
    set((s) => ({
      requests: [...s.requests.filter((r) => r.id !== request.id), request],
    })),
  remove: (id) => set((s) => ({ requests: s.requests.filter((r) => r.id !== id) })),
  reset: () => set({ requests: [] }),
}));
