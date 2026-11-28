// Handover push (spec/05 § Handover — Server). A phone drops its socket when it
// is put away, so a position broadcast over the socket only reaches it after
// it is opened again — too late, the screen would move under the user. Every
// real move is therefore also sent to the phones as a silent data push once it
// has held for SETTLE_MS: browsing through several chats costs one push, and
// each push carries the whole position, so the newest replaces any earlier one
// the phone never got.

import type { Logger } from 'pino';
import type { ViewPosition, ViewPositionStore } from './view-position.js';

/** How long a position must hold before the phones are woken for it. */
export const HANDOVER_PUSH_SETTLE_MS = 3_000;

export interface HandoverPushDeps {
  viewPosition: ViewPositionStore;
  /** Whether the account has "Sync position between surfaces" on. */
  enabled: () => boolean;
  /** Every phone that can be pushed: its surface and token. */
  phones: () => { surfaceId: string; token: string }[];
  /** Send a data-only push (nothing shown) to these tokens. */
  sendData: (tokens: string[], data: Record<string, string>) => Promise<{ failed: string[] }>;
  logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  settleMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

/** The push's data: strings only, as FCM requires. */
export function handoverPushData(p: ViewPosition): Record<string, string> {
  return {
    kind: 'view_position',
    page: p.page,
    ...(p.id !== undefined ? { id: p.id } : {}),
    ...(p.seq !== undefined ? { seq: String(p.seq) } : {}),
    surfaceId: p.surfaceId,
    ...(p.surfaceKind !== undefined ? { surfaceKind: p.surfaceKind } : {}),
    updatedAt: String(p.updatedAt),
  };
}

export function startHandoverPush(deps: HandoverPushDeps): () => void {
  const settleMs = deps.settleMs ?? HANDOVER_PUSH_SETTLE_MS;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  let timer: unknown = null;

  const fire = (p: ViewPosition): void => {
    timer = null;
    if (!deps.enabled()) return;
    // A phone that reported the move is holding it: it does not need waking.
    const tokens = [
      ...new Set(
        deps
          .phones()
          .filter((ph) => ph.surfaceId !== p.surfaceId)
          .map((ph) => ph.token),
      ),
    ];
    if (tokens.length === 0) return;
    deps
      .sendData(tokens, handoverPushData(p))
      .then(({ failed }) => {
        deps.logger.info(
          {
            page: p.page,
            id: p.id,
            seq: p.seq,
            from: p.surfaceId,
            phones: tokens.length,
            failed: failed.length,
          },
          'view-position: pushed to phones',
        );
      })
      .catch((err: unknown) => {
        deps.logger.error(
          { err: (err as Error).message, page: p.page, id: p.id },
          'view-position: push to phones failed',
        );
      });
  };

  const unsub = deps.viewPosition.onChange((p) => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => fire(p), settleMs);
  });

  return () => {
    unsub();
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
}
