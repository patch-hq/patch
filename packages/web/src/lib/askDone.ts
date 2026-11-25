// "Done" for a patch_ask_human (spec/04 § Current status): the user did what the
// agent asked. The host clears the ask, tells the agent and restores the snooze.

import { api } from '../api/rest.js';
import { useUiStore } from '../stores/uiStore.js';
import { failed } from './errorCopy.js';
import type { ChatRow } from '../stores/types.js';

/** Whether the chat has a declared action request outstanding. */
export function isAskOutstanding(row: ChatRow | undefined): boolean {
  return row !== undefined && row.statusKind === 'question' && row.statusDeclared === true;
}

export function pressAskDone(chatId: string): void {
  void api
    .askDone(chatId)
    .catch((e: Error) =>
      useUiStore.getState().pushError(failed('mark done'), undefined, e.message),
    );
}
