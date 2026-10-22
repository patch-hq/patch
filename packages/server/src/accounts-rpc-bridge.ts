// Server-side host-link bridge for `patch.accounts.request` events.
//
// A host's own CLI and agents list and reorder the shared accounts through the
// link the host already holds, so a machine needs no separate login to manage
// them. Order and strategy are the server's to change (spec/03 § Settings); the
// answer goes back to the machine that asked.
//
// NO FALLBACK: a refused change is an error reply carrying the service's own
// code and message, never an empty success.

import type { Logger } from 'pino';
import { PatchAccountsRequestEvent, type WireEvent } from '@patch/wire';
import type { HostLink } from './host-link.js';
import { SettingsError, type BackendId, type SharedSettingsService } from './shared-settings.js';

const BRIDGE_SURFACE_ID = 'accounts-rpc-bridge';

export interface AttachAccountsBridgeOptions {
  link: HostLink;
  shared: SharedSettingsService;
  logger: Logger;
}

/** The shared accounts in order, with each backend's routing strategy. */
export function accountsView(shared: SharedSettingsService): {
  strategy: { claude: string; codex: string };
  claude: unknown[];
  codex: unknown[];
} {
  const { settings, secrets } = shared.changedEvent();
  return {
    strategy: settings.accountStrategy,
    claude: secrets.claude,
    codex: secrets.codex,
  };
}

export function attachAccountsRpcBridge(opts: AttachAccountsBridgeOptions): () => void {
  const { link, shared, logger } = opts;
  return link.onEvent((event: WireEvent, fromHostId: string | null) => {
    if (event.type !== 'patch.accounts.request') return;
    if (fromHostId === null) {
      logger.error(
        { requestId: event.requestId },
        'accounts-rpc-bridge: request with no originating machine; dropping (cannot route a reply)',
      );
      return;
    }
    const reply = (
      ok: boolean,
      result?: unknown,
      error?: { code: string; message: string },
    ): void => {
      const out: WireEvent = ok
        ? { type: 'patch.accounts.response', requestId: event.requestId, ok: true, result }
        : {
            type: 'patch.accounts.response',
            requestId: event.requestId,
            ok: false,
            error: error ?? { code: 'internal', message: 'unknown' },
          };
      link.sendTo(fromHostId, BRIDGE_SURFACE_ID, out);
    };
    const parsed = PatchAccountsRequestEvent.safeParse(event);
    if (!parsed.success) {
      return reply(false, undefined, { code: 'invalid_input', message: parsed.error.message });
    }
    const req = parsed.data;
    try {
      if (req.op === 'order') {
        if (!req.backendId || !req.accountIds) {
          return reply(false, undefined, {
            code: 'invalid_input',
            message: 'order needs backendId and accountIds',
          });
        }
        shared.order(req.backendId as BackendId, req.accountIds);
      } else if (req.op === 'strategy') {
        if (!req.backendId || !req.strategy) {
          return reply(false, undefined, {
            code: 'invalid_input',
            message: 'strategy needs backendId and strategy',
          });
        }
        shared.setStrategy(req.backendId as BackendId, req.strategy);
      }
      reply(true, accountsView(shared));
    } catch (err) {
      if (err instanceof SettingsError) {
        return reply(false, undefined, { code: err.code, message: err.message });
      }
      logger.error({ err: (err as Error).message, op: req.op }, 'accounts-rpc-bridge: failed');
      reply(false, undefined, { code: 'internal', message: (err as Error).message });
    }
  });
}
