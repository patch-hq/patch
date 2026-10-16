// spec/15 § Side threads screen — shared send actions for the trigger (long-
// press menu / branch-again inside the screen) and the screen's own
// composer/controls. Mirrors web's `lib/sideThreadActions.ts`.

import { headCodePoints, type WireEvent } from '@patch/wire';
import { getWs } from '../api/ws';
import { useUiStore } from '../stores/uiStore';
import { useSideThreadsStore } from '../stores/sideThreadsStore';

/** The `Off "…"` line over a side thread: the quoted message, cut on a code point. */
export function offQuoteLabel(quoted: string): string {
  return `Off "${headCodePoints(quoted, 90)}"`;
}

function makeLocalId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The long-press TRIGGER: opens the draft, cursor in its composer. Nothing
 * sent to the host yet. */
export function openSideThreadDraft(
  chatId: string,
  seq: number,
  quotedMessage: string,
  fromBranchId?: string,
): void {
  useSideThreadsStore.getState().openDraft(chatId, {
    seq,
    quotedMessage,
    ...(fromBranchId !== undefined ? { fromBranchId } : {}),
  });
}

/** spec/15 § "IN THE MAIN CHAT" marker: opens the screen on an EXISTING side
 * thread's tab (not a draft). */
export function openExistingSideThread(chatId: string, branchId: string): void {
  useSideThreadsStore.getState().openThread(chatId, branchId);
}

/** Whether the frame went out; a throw is toasted and returns false. */
function send(event: WireEvent): boolean {
  try {
    getWs().send(event);
    return true;
  } catch (e) {
    useUiStore.getState().pushError((e as Error).message);
    return false;
  }
}

export function startSideThread(
  chatId: string,
  seq: number,
  message: string,
  fromBranchId?: string,
): void {
  useSideThreadsStore.getState().expectNewTab(chatId);
  const sent = send({
    type: 'chat.side_request',
    chatId,
    seq,
    message,
    localId: makeLocalId('side'),
    ...(fromBranchId !== undefined ? { branchId: fromBranchId } : {}),
  });
  // Nothing was asked for, so no tab is coming: another surface's branch must
  // not be taken for this one's (it would drop the unsent draft).
  if (!sent) useSideThreadsStore.getState().cancelNewTab(chatId);
}

export function sendToBranch(chatId: string, branchId: string, message: string): void {
  send({ type: 'chat.input', chatId, branchId, message, localId: makeLocalId('branch-input') });
}

export function stopBranch(chatId: string, branchId: string): void {
  send({ type: 'chat.stop_request', chatId, branchId });
}

export function sendBackToChat(chatId: string, branchId: string): void {
  send({ type: 'chat.send_back_request', chatId, branchId });
}

/**
 * A side thread's track is its own records PLUS every ancestor message up to
 * the fork point (spec/04 § Side threads), so the history read carries the
 * whole parent conversation. The thread's own transcript is what follows the
 * fork point.
 */
export function ownThreadEvents<T extends { seq: number }>(
  events: readonly T[],
  forkFromSeq: number | null | undefined,
): T[] {
  return forkFromSeq === null || forkFromSeq === undefined
    ? [...events]
    : events.filter((e) => e.seq > forkFromSeq);
}
