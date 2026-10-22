// Account-wide usage history and per-chat token totals (Settings → Usage).
// Same shape as tool-log.ts: no central store, each machine keeps its own
// probe history and chat logs, and this asks every online machine and merges.
// NO FALLBACK: a machine that does not answer fails the call, because a
// chat list missing one host's chats would look complete.
//
// The named periods (day / week / month) are CACHED here. Reading them means
// every machine scanning its chat logs, which took long enough that the page
// opened on "Loading…" every time. So a period's last answer is kept, stamped
// with when it was read, and handed back at once; a request that finds it
// older than the TTL gets the cached answer AND starts a fresh read behind
// it. A timer re-reads the default period, and any period that has been
// asked for, so the figures are current before anyone looks. A custom range
// is read live: there is no bounded set of them to keep.

import { randomUUID } from 'node:crypto';
import type { ChatTokenUsage, PatchUsageReadResponseEvent, UsageSample } from '@patch/wire';
import type { HostLink } from './host-link.js';

export const USAGE_MAX_WINDOW_MS = 92 * 24 * 60 * 60 * 1000;
export const USAGE_READ_TIMEOUT_MS = 30_000;
/** How old a cached period may be before a request also starts a re-read. */
export const USAGE_CACHE_TTL_MS = 5 * 60_000;
/** How often the cached periods are re-read without anyone asking. */
export const USAGE_REFRESH_EVERY_MS = 10 * 60_000;
const READ_SURFACE_ID = 'usage-read';

const DAY_MS = 24 * 60 * 60 * 1000;
export const USAGE_PERIODS = ['day', 'week', 'month'] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];
export const USAGE_PERIOD_MS: Record<UsagePeriod, number> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
};
/** The period Settings → Usage opens on, so it is the one kept warm. */
export const USAGE_DEFAULT_PERIOD: UsagePeriod = 'week';

export function isUsagePeriod(value: unknown): value is UsagePeriod {
  return typeof value === 'string' && (USAGE_PERIODS as readonly string[]).includes(value);
}

export interface UsageReport {
  /** The window the figures cover, and when they were read. */
  since: number;
  until: number;
  at: number;
  samples: (UsageSample & { hostId: string })[];
  chats: (ChatTokenUsage & { hostId: string })[];
}

export interface UsageReader {
  /** A live read of an arbitrary window. */
  query(q: { since: number; until: number }): Promise<UsageReport>;
  /**
   * A named period from the cache: at once when there is one, after a live
   * read the first time. A cached answer past the TTL is still the answer,
   * with a re-read started behind it.
   */
  cached(period: UsagePeriod): Promise<UsageReport>;
  close(): void;
}

export function createUsageReader(deps: {
  hostLink: HostLink;
  now?: () => number;
  /** 0 turns the background refresh off (tests). */
  refreshEveryMs?: number;
  onRefreshError?: (period: UsagePeriod, err: Error) => void;
}): UsageReader {
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

  const query = async (q: { since: number; until: number }): Promise<UsageReport> => {
    const until = Math.min(q.until, now());
    const since = Math.max(Math.min(q.since, until), until - USAGE_MAX_WINDOW_MS);
    const answers = await Promise.all(
      hostLink.onlineHostIds().map((h) => readHost(h, since, until)),
    );
    return {
      since,
      until,
      at: now(),
      samples: answers
        .flatMap((a) => a.samples.map((s) => ({ ...s, hostId: a.hostId })))
        .sort((a, b) => a.ts - b.ts),
      chats: answers
        .flatMap((a) => a.chats.map((c) => ({ ...c, hostId: a.hostId })))
        .sort((a, b) => b.tokens - a.tokens),
    };
  };

  const cache = new Map<UsagePeriod, UsageReport>();
  /** One read in flight per period: a burst of requests shares it. */
  const inFlight = new Map<UsagePeriod, Promise<UsageReport>>();

  const refresh = (period: UsagePeriod): Promise<UsageReport> => {
    const running = inFlight.get(period);
    if (running) return running;
    const until = now();
    const read = query({ since: until - USAGE_PERIOD_MS[period], until })
      .then((report) => {
        cache.set(period, report);
        return report;
      })
      .finally(() => inFlight.delete(period));
    inFlight.set(period, read);
    return read;
  };

  const cached = async (period: UsagePeriod): Promise<UsageReport> => {
    const have = cache.get(period);
    if (!have) return refresh(period);
    if (now() - have.at > USAGE_CACHE_TTL_MS) {
      refresh(period).catch((err: Error) => deps.onRefreshError?.(period, err));
    }
    return have;
  };

  const refreshEvery = deps.refreshEveryMs ?? USAGE_REFRESH_EVERY_MS;
  let timer: NodeJS.Timeout | null = null;
  if (refreshEvery > 0) {
    timer = setInterval(() => {
      if (hostLink.onlineHostIds().length === 0) return;
      const periods = new Set<UsagePeriod>([USAGE_DEFAULT_PERIOD, ...cache.keys()]);
      for (const period of periods) {
        refresh(period).catch((err: Error) => deps.onRefreshError?.(period, err));
      }
    }, refreshEvery);
    timer.unref();
  }

  return {
    query,
    cached,
    close() {
      if (timer) clearInterval(timer);
      unsubscribe();
      for (const w of [...waiting.values()]) w.reject(new Error('usage: server closing'));
    },
  };
}
