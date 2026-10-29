// Wake host — the host half (spec/08 § Wake host).
//
// `host.wake_request` asks this host to be awake by `at`. On macOS that is
// `pmset schedule wake`, which needs root: the host runs it through `sudo -n`,
// so a host without passwordless sudo for pmset reports exactly that rather
// than pretending. A Mac on battery is refused too — a scheduled wake on
// battery drains it overnight and many lids stay shut anyway.
//
// NO FALLBACK: every way this can fail is reported back in `host.wake_result`.

import { execFile } from 'node:child_process';
import type { Logger } from 'pino';
import type { HostWakeRequestEvent, WireEvent } from '@patch/wire';

export type RunCommand = (cmd: string, args: string[]) => Promise<string>;

const run: RunCommand = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });

const pad = (n: number): string => String(n).padStart(2, '0');

/** `MM/dd/yyyy HH:mm:ss` in the host's local time, the format pmset takes. */
export function pmsetDate(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export async function handleHostWake(
  event: HostWakeRequestEvent,
  sender: (e: WireEvent) => void,
  logger: Logger,
  deps: { platform?: NodeJS.Platform; run?: RunCommand } = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const exec = deps.run ?? run;
  const reply = (ok: boolean, error?: string): void => {
    sender({
      type: 'host.wake_result',
      jobId: event.jobId,
      at: event.at,
      ok,
      ...(error !== undefined ? { error } : {}),
    });
  };
  try {
    if (platform !== 'darwin') {
      throw new Error(`waking the host is only supported on macOS, this is ${platform}`);
    }
    const batt = await exec('pmset', ['-g', 'batt']);
    if (!batt.includes('AC Power')) {
      throw new Error('the host is not on AC power');
    }
    await exec('sudo', ['-n', 'pmset', 'schedule', 'wake', pmsetDate(event.at)]);
    logger.info({ jobId: event.jobId, at: event.at }, 'host.wake_request: wake scheduled');
    reply(true);
  } catch (err) {
    const message = (err as Error).message;
    logger.warn({ jobId: event.jobId, err: message }, 'host.wake_request: could not schedule');
    reply(false, message);
  }
}
