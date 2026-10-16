// SnoozeMenu — the chat header's snooze control (spec/04 § Snooze, spec/14
// § Chat panel header → Snooze).
//
// A clock that opens the Snooze sheet (`SnoozeSheet`), where the wake time is
// chosen and the chat's background work is shown. On a chat that is already
// snoozed it is a direct Unsnooze, with no sheet. The unsnooze is optimistic
// and reverts on failure with a toast (NO FALLBACK).

import type { JSX } from 'react';
import { Clock } from 'lucide-react';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api } from '../api/rest.js';
import { isSnoozed } from '../stores/types.js';
import type { ChatRow } from '../stores/types.js';
import { formatWakeTime } from '../lib/snoozePresets.js';
import { failed } from '../lib/errorCopy.js';

export { formatWakeTime };

// With `label`, the trigger is a whole-row menu item (icon + text, the same
// `.head-menu-item` its siblings in the ⋯ / hamburger menus use) so the word
// is as clickable as the clock; without it, the icon-only header button.
export function SnoozeMenu({
  row,
  iconSize,
  label,
}: {
  row: ChatRow;
  iconSize: number;
  label?: string;
}): JSX.Element {
  const setSnoozed = useChatStore((s) => s.setSnoozed);
  const pushError = useUiStore((s) => s.pushError);
  const openSnoozeSheet = useUiStore((s) => s.openSnoozeSheet);
  const snoozed = isSnoozed(row);

  async function unsnooze(): Promise<void> {
    const previous = row.snoozedUntil;
    setSnoozed(row.chatId, null);
    try {
      await api.snoozeChat(row.chatId, null);
    } catch (err) {
      setSnoozed(row.chatId, previous);
      pushError(failed('unsnooze'), undefined, (err as Error).message);
    }
  }

  return (
    <span className={label ? 'snooze-wrap snooze-wrap-row' : 'snooze-wrap'}>
      <button
        type="button"
        className={`${label ? 'head-menu-item' : 'head-action'} ${snoozed ? 'is-snoozed' : ''}`}
        role={label ? 'menuitem' : undefined}
        data-testid="action-snooze"
        aria-label={snoozed ? 'Unsnooze' : 'Snooze chat'}
        title={snoozed ? `Snoozed until ${formatWakeTime(row.snoozedUntil!)}` : 'Snooze'}
        onClick={() =>
          snoozed ? void unsnooze() : openSnoozeSheet({ kind: 'chat', chatId: row.chatId })
        }
      >
        <Clock size={iconSize} aria-hidden />
        {label === undefined ? undefined : snoozed ? 'Unsnooze' : label}
      </button>
    </span>
  );
}
