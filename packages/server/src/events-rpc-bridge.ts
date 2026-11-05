// Server-side host-link bridge for `patch.events.*`: `patch logs` on a host
// machine tails the account's event stream through the host's link rather than
// a separately paired credential. The host subscribes on the CLI's behalf and
// each matching event is sent back to that machine until it unsubscribes or its
// link drops.
//
// NO FALLBACK: a subscription that cannot be honoured is not silently ignored —
// the host's link going offline ends it, and the host reports that to the CLI.

import type { Logger } from 'pino';
import type { WireEvent } from '@patch/wire';
import type { HostLink } from './host-link.js';

const BRIDGE_SURFACE_ID = 'events-rpc-bridge';

/** The event types `patch logs` shows. */
export const RELAYED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'chat.spawned',
  'chat.message',
  'chat.tool_call',
  'chat.tool_result',
  'chat.state',
  'chat.stopped',
  'chat.error',
  'host.online',
  'host.offline',
  'notify',
]);

export interface AttachEventsBridgeOptions {
  link: HostLink;
  /** Observe every account event headed for surfaces (WsHub.onBroadcast). */
  onBroadcast: (tap: (event: WireEvent) => void) => () => void;
  logger: Logger;
}

export function attachEventsRpcBridge(opts: AttachEventsBridgeOptions): () => void {
  const { link, logger } = opts;
  // hostId → subscription ids
  const subs = new Map<string, Set<string>>();

  const detachLink = link.onEvent((event, fromHostId) => {
    if (event.type !== 'patch.events.subscribe' && event.type !== 'patch.events.unsubscribe') {
      return;
    }
    if (fromHostId === null) {
      logger.error('events-rpc-bridge: no originating machine; dropping');
      return;
    }
    if (event.type === 'patch.events.subscribe') {
      let set = subs.get(fromHostId);
      if (!set) subs.set(fromHostId, (set = new Set()));
      set.add(event.subscriptionId);
      return;
    }
    const set = subs.get(fromHostId);
    set?.delete(event.subscriptionId);
    if (set?.size === 0) subs.delete(fromHostId);
  });

  const detachStatus = link.onHostStatus((hostId, status) => {
    if (status === 'offline') subs.delete(hostId);
  });

  const detachTap = opts.onBroadcast((event) => {
    if (subs.size === 0 || !RELAYED_EVENT_TYPES.has(event.type)) return;
    for (const [hostId, ids] of subs) {
      // Never buffer for an offline machine: a stream replayed late is wrong.
      if (!link.isOnline(hostId)) continue;
      for (const subscriptionId of ids) {
        link.sendTo(hostId, BRIDGE_SURFACE_ID, {
          type: 'patch.events.event',
          subscriptionId,
          event: event as unknown as Record<string, unknown>,
        });
      }
    }
  });

  return () => {
    detachLink();
    detachStatus();
    detachTap();
    subs.clear();
  };
}
