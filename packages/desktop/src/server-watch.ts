// A host on this host that has lost its server (spec/12 § Server lost).
//
// The host dials out, so it is the first to know the server is gone, and the
// desktop app sits on the same host. A minute without the server is shown
// rather than left to look like chats silently not working. The check reads
// the host's own control socket from the main process, so a hidden or
// throttled window cannot miss it.

import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';

/** How long the host must have been without its server before it is called lost. */
export const SERVER_LOST_AFTER_MS = 60_000;

export interface HostLinkReport {
  online: boolean;
  offlineSince: number | null;
}

export type ServerWatchState = { lost: false } | { lost: true; sinceMs: number };

export function serverWatchState(report: HostLinkReport, now: number): ServerWatchState {
  if (report.online || report.offlineSince === null) return { lost: false };
  const sinceMs = now - report.offlineSince;
  return sinceMs > SERVER_LOST_AFTER_MS ? { lost: true, sinceMs } : { lost: false };
}

export function serverLostText(sinceMs: number): string {
  const mins = Math.max(1, Math.round(sinceMs / 60_000));
  return `This Mac's host can't reach the Patch server (${mins} min). Chats won't update until it is back.`;
}

/**
 * Ask the running host for its link state. Throws when the host is not running
 * or answers badly: the caller decides how to report that.
 */
export function readHostLink(
  patchHome: string,
  socketPath = join(patchHome, 'host.sock'),
): Promise<HostLinkReport> {
  const key = readFileSync(join(patchHome, 'local.key'), 'utf8').trim();
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: '/internal/diag/link',
        headers: { authorization: `Bearer ${key}` },
        timeout: 5000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200)
            return reject(new Error(`host link diag: HTTP ${res.statusCode}`));
          try {
            resolve(JSON.parse(body) as HostLinkReport);
          } catch (e) {
            reject(e as Error);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('host link diag: timed out')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Poll the host and report transitions only: `onLost` once when the minute is
 * passed, `onRestored` once when the link is back. A host that cannot be read
 * is reported through `onError`, never treated as healthy.
 */
export function watchServerLink(opts: {
  read: () => Promise<HostLinkReport>;
  onLost: (sinceMs: number) => void;
  onRestored: () => void;
  onError: (e: Error) => void;
  intervalMs?: number;
  now?: () => number;
}): () => void {
  let lost = false;
  const now = opts.now ?? Date.now;
  const tick = async (): Promise<void> => {
    try {
      const state = serverWatchState(await opts.read(), now());
      if (state.lost) {
        opts.onLost(state.sinceMs);
        lost = true;
      } else if (lost) {
        lost = false;
        opts.onRestored();
      }
    } catch (e) {
      opts.onError(e as Error);
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs ?? 15_000);
  void tick();
  return () => clearInterval(timer);
}
