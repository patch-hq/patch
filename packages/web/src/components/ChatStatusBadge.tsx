// The status a chat shows, on every web surface that draws one.
//
// `deriveBadge` is a pure function of the chat row, but one input to the
// status lives outside it: an unread notification entry (spec/09 § Notification
// log). That entry is unread output like any other, so it lifts a quiet chat to
// the unread `done` dot (spec/14 § Status badges). It used to be applied only
// inside the main sidebar's row, so the mini sidebar, the pane tab and the
// thread and batch panels showed a different status for the same chat. Every
// surface calls this one hook so they cannot disagree.

import type { JSX } from 'react';
import type { PendingWake } from '@patch/wire';
import { deriveBadge } from '../stores/chatStore.js';
import { useChatHasUnread } from '../stores/notificationsStore.js';
import type { ChatRow, DisplayBadge } from '../stores/types.js';
import { StatusBadge } from './StatusBadge.js';

/**
 * Only the quiet states are lifted. A decision, a failure or a running turn
 * outranks an unread entry exactly as it outranks `done`.
 */
export function liftForUnreadNotification(badge: DisplayBadge, hasUnread: boolean): DisplayBadge {
  return hasUnread && (badge === 'read' || badge === 'background' || badge === 'monitoring')
    ? 'done'
    : badge;
}

/** The chat's badge, or null when there is no row yet. */
export function useChatBadge(row: ChatRow | null | undefined): DisplayBadge | null {
  const hasUnread = useChatHasUnread(row?.chatId ?? '');
  return row ? liftForUnreadNotification(deriveBadge(row), hasUnread) : null;
}

export function ChatStatusBadge({
  row,
}: {
  row: ChatRow & { pendingWake?: PendingWake | null };
}): JSX.Element {
  const badge = useChatBadge(row)!;
  return (
    <StatusBadge
      badge={badge}
      pendingWake={row.pendingWake}
      failureReason={row.lastError?.message ?? null}
    />
  );
}
