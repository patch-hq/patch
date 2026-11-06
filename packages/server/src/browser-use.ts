// Settings → Computer use (spec/06 § Browser tools). Whether an agent is
// driving a host's browser lives on that host, so this is a read-through:
// ask each online host for its status, or tell one to stop. NO FALLBACK: a host
// that does not answer is reported as such, never as "idle".

import { randomUUID } from 'node:crypto';
import type { PatchBrowserUseResponseEvent } from '@patch/wire';
import type { HostLink } from './host-link.js';

export const BROWSER_USE_TIMEOUT_MS = 8_000;
const SURFACE_ID = 'browser-use';

export interface HostComputerUse {
  hostId: string;
  name: string | null;
  active: boolean;
  actionLabel?: string;
  since?: number;
  tabs: number;
  lastStoppedAt?: number;
  closed?: number;
}

export type HostComputerUseResult =
  | HostComputerUse
  | { hostId: string; name: string | null; error: string };

export interface BrowserUseReader {
  statusAll(): Promise<HostComputerUseResult[]>;
  stop(hostId: string): Promise<HostComputerUse>;
  close(): void;
}

export class HostOfflineError extends Error {
  constructor(hostId: string) {
    super(`host ${hostId} is offline`);
  }
}

export function createBrowserUseReader(deps: {
  hostLink: HostLink;
  hostName: (hostId: string) => string | undefined;
}): BrowserUseReader {
  const { hostLink } = deps;
  const waiting = new Map<
    string,
    { resolve: (e: PatchBrowserUseResponseEvent) => void; reject: (err: Error) => void }
  >();
  const unsubscribe = hostLink.onEvent((event) => {
    if (event.type !== 'patch.browser_use.response') return;
    waiting.get(event.requestId)?.resolve(event);
  });

  const ask = (hostId: string, action: 'status' | 'stop'): Promise<HostComputerUse> =>
    new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        waiting.delete(requestId);
        reject(new Error(`host ${hostId} did not answer within ${BROWSER_USE_TIMEOUT_MS / 1000}s`));
      }, BROWSER_USE_TIMEOUT_MS);
      timer.unref();
      waiting.set(requestId, {
        resolve: (e) => {
          clearTimeout(timer);
          waiting.delete(requestId);
          resolve({
            hostId,
            name: deps.hostName(hostId) ?? null,
            active: e.active,
            tabs: e.tabs,
            ...(e.actionLabel ? { actionLabel: e.actionLabel } : {}),
            ...(e.since !== undefined ? { since: e.since } : {}),
            ...(e.lastStoppedAt !== undefined ? { lastStoppedAt: e.lastStoppedAt } : {}),
            ...(e.closed !== undefined ? { closed: e.closed } : {}),
          });
        },
        reject: (err) => {
          clearTimeout(timer);
          waiting.delete(requestId);
          reject(err);
        },
      });
      hostLink.sendTo(hostId, SURFACE_ID, {
        type: 'patch.browser_use.request',
        requestId,
        action,
      });
    });

  return {
    async statusAll() {
      return Promise.all(
        hostLink.onlineHostIds().map(async (id): Promise<HostComputerUseResult> => {
          try {
            return await ask(id, 'status');
          } catch (err) {
            return {
              hostId: id,
              name: deps.hostName(id) ?? null,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );
    },
    async stop(hostId) {
      if (!hostLink.isOnline(hostId)) throw new HostOfflineError(hostId);
      return ask(hostId, 'stop');
    },
    close() {
      unsubscribe();
      for (const w of waiting.values()) w.reject(new Error('server closing'));
      waiting.clear();
    },
  };
}
