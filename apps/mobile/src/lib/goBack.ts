// What a screen's own back control does (spec/15 § Navigation shell): return
// to the screen the user was on before, wherever that was, and go to the
// screen's parent only when there is nothing beneath it in the stack.
//
// "Nothing beneath" is real: a launcher shortcut or a patch:// link opened on a
// cold start mounts its screen as the only one in the stack, and a bare
// `router.back()` there does nothing — a back arrow that is dead to the tap.

import { useCallback } from 'react';
import { useRouter, type Href } from 'expo-router';

/** The router surface `goBack` needs — satisfied by expo-router's `useRouter()`. */
export interface BackRouter {
  canGoBack(): boolean;
  back(): void;
  replace(href: Href): void;
}

export function goBack(router: BackRouter, parent: Href): void {
  if (router.canGoBack()) router.back();
  else router.replace(parent);
}

/**
 * Back from a chat always lands on the Chats tab, whatever chat or link the
 * user came from. `dismissTo` pops to the tab if it is already beneath, and
 * navigates to it when the chat was opened alone on a cold start.
 */
export function goHome(router: { dismissTo(href: Href): void }): void {
  router.dismissTo('/(tabs)/chats');
}

/** A stable handler for a back control whose parent screen is `parent`. */
export function useGoBack(parent: Href): () => void {
  const router = useRouter();
  return useCallback(() => goBack(router, parent), [router, parent]);
}
