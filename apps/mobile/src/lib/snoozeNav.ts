// Snoozing the open chat moves you on to the next chat (spec/04 § Snooze).
// A snoozed chat leaves the Chats tab's live list, so staying on it leaves you
// on a chat you just put away. Where you land: the next chat in swipe order,
// else the previous one, else the Chats tab.

import { router, type Href } from 'expo-router';
import { useChatStore } from '../stores/chatStore';
import { swipeOrder } from './chatSwipeOrder';
import { goHome } from './goBack';

/** The router surface this needs — satisfied by expo-router's `router`. */
export interface SnoozeNavRouter {
  replace(href: Href): void;
  dismissTo(href: Href): void;
}

/**
 * Leave the open chat if it is one of `snoozedIds`. Call it BEFORE flipping the
 * rows to snoozed — the destination is read off the list as it still stands.
 * A no-op when the open chat is not being snoozed.
 */
export function navigateAfterSnooze(
  snoozedIds: readonly string[],
  nav: SnoozeNavRouter = router,
): void {
  const { activeChatId, chats } = useChatStore.getState();
  if (activeChatId === null || !snoozedIds.includes(activeChatId)) return;
  const order = swipeOrder(chats);
  const i = order.indexOf(activeChatId);
  // A project snooze takes its neighbours with it: the nearest chat after the
  // open one that is staying, else the nearest before it.
  const staying = (id: string): boolean => !snoozedIds.includes(id);
  const target =
    i < 0
      ? undefined
      : (order.slice(i + 1).find(staying) ?? order.slice(0, i).reverse().find(staying));
  if (target) nav.replace(`/chats/${target}` as Href);
  else goHome(nav);
}
