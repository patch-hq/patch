// Browser tunnel relay (spec/02 § Browser — Route through, spec/03 § Browser
// tunnel): the server-side half of routing one host's agent browser through
// another host's network.
//
// Unlike `cross-host.ts`'s request/response relays, a tunnel stream is
// symmetric and long-lived: once `patch.browser_tunnel.open` is accepted,
// `ready` / `data` / `error` / `close` can arrive from EITHER side and must
// be relayed to the OTHER side, for as long as the stream is open — there is
// no single caller waiting on a single answer. So the bridge tracks each
// open stream as an unordered pair of machines and, for every later frame
// carrying that `streamId`, sends it to whichever of the two did NOT just
// send it.
//
// NO FALLBACK: `open` naming an unregistered or offline routing host is
// refused immediately with `patch.browser_tunnel.error`, back to the
// browsing host — never silently dropped, and never left for Chromium's own
// SOCKS timeout to surface as something unexplained. A routing host that
// goes offline mid-stream gets the same treatment from the other end: the
// browsing host is told `host_offline` and the stream is dropped, rather than
// left open against a machine that can no longer answer it.

import type { Logger } from 'pino';
import type { WireEvent } from '@patch/wire';
import type { HostLink } from './host-link.js';
import type { Registry } from './registry.js';

const BRIDGE_SURFACE_ID = 'browser-tunnel-bridge';

export interface BrowserTunnelBridgeDeps {
  logger: Logger;
  hostLink: HostLink;
  registry: Registry;
}

interface Route {
  browsingHostId: string;
  routingHostId: string;
}

export function registerBrowserTunnelBridge(deps: BrowserTunnelBridgeDeps): () => void {
  const { logger, hostLink, registry } = deps;

  /** streamId → the two machines carrying this stream, for as long as it's open. */
  const routes = new Map<string, Route>();

  const otherSide = (streamId: string, from: string): string | undefined => {
    const route = routes.get(streamId);
    if (!route) return undefined;
    if (route.browsingHostId === from) return route.routingHostId;
    if (route.routingHostId === from) return route.browsingHostId;
    return undefined;
  };

  const refuseOpen = (
    browsingHostId: string,
    streamId: string,
    code: 'host_not_registered' | 'host_offline',
    message: string,
  ): void => {
    hostLink.sendTo(browsingHostId, BRIDGE_SURFACE_ID, {
      type: 'patch.browser_tunnel.error',
      streamId,
      code,
      message,
    });
  };

  const unsubEvent = hostLink.onEvent((event: WireEvent, fromHostId: string | null) => {
    if (fromHostId === null) return;

    if (event.type === 'patch.browser_tunnel.open') {
      if (!registry.isRegisteredHost(event.hostId)) {
        logger.warn(
          { from: fromHostId, target: event.hostId, streamId: event.streamId },
          'browser tunnel open named an unregistered machine',
        );
        refuseOpen(
          fromHostId,
          event.streamId,
          'host_not_registered',
          `no machine registered with hostId: ${event.hostId}`,
        );
        return;
      }
      if (!hostLink.isOnline(event.hostId)) {
        logger.warn(
          { from: fromHostId, target: event.hostId, streamId: event.streamId },
          'browser tunnel open named an offline machine',
        );
        refuseOpen(
          fromHostId,
          event.streamId,
          'host_offline',
          `routing host ${event.hostId} is offline`,
        );
        return;
      }
      routes.set(event.streamId, {
        browsingHostId: fromHostId,
        routingHostId: event.hostId,
      });
      logger.info(
        { from: fromHostId, target: event.hostId, streamId: event.streamId, host: event.host },
        'relaying browser tunnel open to the routing machine',
      );
      hostLink.sendTo(event.hostId, BRIDGE_SURFACE_ID, event);
      return;
    }

    if (
      event.type === 'patch.browser_tunnel.ready' ||
      event.type === 'patch.browser_tunnel.data' ||
      event.type === 'patch.browser_tunnel.error'
    ) {
      const to = otherSide(event.streamId, fromHostId);
      if (!to) {
        logger.warn(
          { type: event.type, from: fromHostId, streamId: event.streamId },
          'browser tunnel frame for a stream this server is not carrying; dropping',
        );
        return;
      }
      // An error always ends the stream, and no close follows it.
      if (event.type === 'patch.browser_tunnel.error') routes.delete(event.streamId);
      hostLink.sendTo(to, BRIDGE_SURFACE_ID, event);
      return;
    }

    if (event.type === 'patch.browser_tunnel.close') {
      const to = otherSide(event.streamId, fromHostId);
      routes.delete(event.streamId);
      if (to) hostLink.sendTo(to, BRIDGE_SURFACE_ID, event);
      return;
    }
  });

  // A machine on either side of an open stream drops: the other side cannot
  // be answered any more, so it is told rather than left hanging against a
  // machine that will never reply.
  const unsubStatus = hostLink.onHostStatus((hostId, status) => {
    if (status !== 'offline') return;
    for (const [streamId, route] of routes) {
      if (route.browsingHostId !== hostId && route.routingHostId !== hostId) continue;
      const survivor = route.browsingHostId === hostId ? route.routingHostId : route.browsingHostId;
      routes.delete(streamId);
      hostLink.sendTo(survivor, BRIDGE_SURFACE_ID, {
        type: 'patch.browser_tunnel.error',
        streamId,
        code: 'host_offline',
        message: `machine ${hostId} went offline mid-stream`,
      });
    }
  });

  return () => {
    unsubEvent();
    unsubStatus();
    routes.clear();
  };
}
