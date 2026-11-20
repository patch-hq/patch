// Restart a host that has stopped answering (spec/12 § Host must never freeze).
//
// The host is a launchd service with its own life; the desktop app only sits
// beside it. When the host's control socket stops answering — wedged, not
// merely without its server — the app kickstarts the service. It never starts a
// service that is not loaded, so a host the person turned off stays off.
// Runs in the main process: a hidden window's timers cannot be trusted.

import { execFile } from 'node:child_process';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Consecutive unanswered checks before the host is restarted. */
export const WATCHDOG_STRIKES = 4;
/** After a restart, leave the host this long to come up before judging it again. */
export const WATCHDOG_GRACE_MS = 60_000;

/** Whether the host's control socket answers a ping within the deadline. */
export function hostAnswers(
  patchHome: string,
  socketPath = join(patchHome, 'host.sock'),
  timeoutMs = 5_000,
): Promise<boolean> {
  const key = readFileSync(join(patchHome, 'local.key'), 'utf8').trim();
  return new Promise((resolve) => {
    const req = request(
      {
        socketPath,
        path: '/internal/diag/link',
        headers: { authorization: `Bearer ${key}` },
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode === 200));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

/** `launchctl kickstart -k`: restarts a loaded service, fails on one that is not loaded. */
export function kickstartHost(label: string, uid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], (err, _out, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(),
    );
  });
}

export function watchHost(opts: {
  answers: () => Promise<boolean>;
  restart: () => Promise<void>;
  onRestart: (ok: boolean, detail: string) => void;
  intervalMs?: number;
  strikes?: number;
  graceMs?: number;
  now?: () => number;
}): () => void {
  const now = opts.now ?? Date.now;
  const strikes = opts.strikes ?? WATCHDOG_STRIKES;
  let missed = 0;
  let busy = false;
  let graceUntil = 0;
  const tick = async (): Promise<void> => {
    if (busy || now() < graceUntil) return;
    busy = true;
    try {
      let ok: boolean;
      try {
        ok = await opts.answers();
      } catch (e) {
        // Cannot judge (e.g. the host's key file is unreadable): say so, restart nothing.
        opts.onRestart(false, `host check failed: ${(e as Error).message}`);
        return;
      }
      if (ok) {
        missed = 0;
        return;
      }
      missed += 1;
      if (missed < strikes) return;
      missed = 0;
      graceUntil = now() + (opts.graceMs ?? WATCHDOG_GRACE_MS);
      try {
        await opts.restart();
        opts.onRestart(true, `host unanswered for ${strikes} checks, restarted`);
      } catch (e) {
        opts.onRestart(false, (e as Error).message);
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs ?? 15_000);
  void tick();
  return () => clearInterval(timer);
}
