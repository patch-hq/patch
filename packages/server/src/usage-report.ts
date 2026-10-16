// Account-wide usage history and per-chat token totals (Settings → Usage).
// Same shape as tool-log.ts: no central store, each machine keeps its own
// probe history and chat logs, and this asks every online machine and merges.
// NO FALLBACK: a machine that does not answer fails the call, because a
// chat list missing one host's chats would look complete.

import { randomUUID } from 'node:crypto';
import type { ChatTokenUsage, PatchUsageReadResponseEvent, UsageSample } from '@patch/wire';
import type { HostLink } from './host-link.js';

export const USAGE_MAX_WINDOW_MS = 92 * 24 * 60 * 60 * 1000;
export const USAGE_READ_TIMEOUT_MS = 30_000;
const READ_SURFACE_ID = 'usage-read';

export interface UsageReport {
  samples: (UsageSample & { hostId: string })[];
  chats: (ChatTokenUsage & { hostId: string })[];
}

export interface UsageReader {
  query(q: { since: number; until: number }): Promise<UsageReport>;
  close(): void;
}

export function createUsageReader(deps: { hostLink: HostLink; now?: () => number }): UsageReader {
  const { hostLink } = deps;
  const now = deps.now ?? Date.now;
  const waiting = new Map<
    string,
    { resolve: (e: PatchUsageReadResponseEvent) => void; reject: (err: Error) => void }
  >();

  const unsubscribe = hostLink.onEvent((event) => {
    if (event.type !== 'patch.usage.read.response') return;
    waiting.get(event.requestId)?.resolve(event);
  });

  const readHost = (
    hostId: string,
    since: number,
    until: number,
  ): Promise<PatchUsageReadResponseEvent> =>
    new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        waiting.delete(requestId);
        reject(
          new Error(
            `usage: machine ${hostId} did not answer within ${USAGE_READ_TIMEOUT_MS / 1000}s`,
          ),
        );
      }, USAGE_READ_TIMEOUT_MS);
      timer.unref();
      waiting.set(requestId, {
        resolve: (e) => {
          clearTimeout(timer);
          waiting.delete(requestId);
          resolve(e);
        },
        reject: (err) => {
          clearTimeout(timer);
          waiting.delete(requestId);
          reject(err);
        },
      });
      hostLink.sendTo(hostId, READ_SURFACE_ID, {
        type: 'patch.usage.read.request',
        requestId,
        since,
        until,
      });
    });

  return {
    async query(q) {
      const until = Math.min(q.until, now());
      const since = Math.max(Math.min(q.since, until), until - USAGE_MAX_WINDOW_MS);
      const answers = await Promise.all(
        hostLink.onlineHostIds().map((h) => readHost(h, since, until)),
      );
      return {
        samples: answers
          .flatMap((a) => a.samples.map((s) => ({ ...s, hostId: a.hostId })))
          .sort((a, b) => a.ts - b.ts),
        chats: answers
          .flatMap((a) => a.chats.map((c) => ({ ...c, hostId: a.hostId })))
          .sort((a, b) => b.tokens - a.tokens),
      };
    },
    close() {
      unsubscribe();
      for (const w of [...waiting.values()]) w.reject(new Error('usage: server closing'));
    },
  };
}
