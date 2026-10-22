// The status a chat shows on every surface that draws one. Mirrors
// packages/web/src/components/ChatStatusBadge.tsx: `deriveBadge` is a pure
// function of the row, but an unread notification entry (spec/09 § bell) is
// unread output too, so it lifts a quiet chat to the unread `done` dot
// (spec/14 § Status badges). Every row-drawing surface calls this one hook.

import { useNotificationsStore } from '../stores/notificationsStore';
import { deriveBadge, type ChatRow, type DisplayBadge } from '../stores/types';

/** Only the quiet states lift; a decision, a failure or a running turn outranks an unread entry. */
export function liftForUnreadNotification(badge: DisplayBadge, hasUnread: boolean): DisplayBadge {
  return hasUnread && (badge === 'read' || badge === 'background' || badge === 'monitoring')
    ? 'done'
    : badge;
}

export function useChatBadge(row: ChatRow): DisplayBadge {
  const hasUnread = useNotificationsStore((s) =>
    s.items.some((n) => n.chatId === row.chatId && n.readAt === null),
  );
  return liftForUnreadNotification(deriveBadge(row), hasUnread);
}
