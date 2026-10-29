// Battery state for `host.host.power`. A laptop host that hibernates on a flat
// battery misses every job it owns, so the server needs to know the charge.
// Unreadable output throws: absent power means "no battery", never "unknown".

import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';

export interface PowerState {
  onBattery: boolean;
  percent: number;
}

/** Parse `pmset -g batt`. Undefined when the host has no internal battery. */
export function parsePmsetBatt(out: string): PowerState | undefined {
  if (!out.includes('InternalBattery')) return undefined;
  const source = /Now drawing from '([^']+)'/.exec(out);
  const pct = /(\d+)%/.exec(out);
  if (!source || !pct) throw new Error(`pmset -g batt: unrecognised output: ${out.slice(0, 200)}`);
  return { onBattery: source[1] === 'Battery Power', percent: Number(pct[1]) };
}

export interface SysfsReader {
  list: (dir: string) => string[];
  read: (file: string) => string;
}

const realFs: SysfsReader = {
  list: (d) => readdirSync(d),
  read: (f) => readFileSync(f, 'utf8'),
};

/** Read the first battery under /sys/class/power_supply. Undefined when there is none. */
export function readPowerLinux(
  root = '/sys/class/power_supply',
  fs: SysfsReader = realFs,
): PowerState | undefined {
  for (const name of fs.list(root)) {
    if (fs.read(`${root}/${name}/type`).trim() !== 'Battery') continue;
    const percent = Number(fs.read(`${root}/${name}/capacity`).trim());
    const status = fs.read(`${root}/${name}/status`).trim();
    if (!Number.isFinite(percent)) throw new Error(`power_supply ${name}: bad capacity`);
    return { onBattery: status === 'Discharging', percent };
  }
  return undefined;
}

const execFileAsync = promisify(execFile);

export async function readPower(
  platform: NodeJS.Platform = process.platform,
): Promise<PowerState | undefined> {
  if (platform === 'darwin') {
    const { stdout } = await execFileAsync('/usr/bin/pmset', ['-g', 'batt'], { timeout: 10_000 });
    return parsePmsetBatt(stdout);
  }
  if (platform === 'linux') return readPowerLinux();
  return undefined;
}

export interface PowerWatcherOptions {
  read?: () => Promise<PowerState | undefined>;
  onChange: () => void;
  onError: (err: Error) => void;
  intervalMs?: number;
}

export interface PowerWatcher {
  current(): PowerState | undefined;
  poll(): Promise<void>;
  start(): void;
  stop(): void;
}

/** Polls the battery and calls `onChange` when the reading differs from the last one. */
export function createPowerWatcher(opts: PowerWatcherOptions): PowerWatcher {
  const read = opts.read ?? (() => readPower());
  let state: PowerState | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const watcher: PowerWatcher = {
    current: () => state,
    async poll() {
      const next = await read();
      if (next?.onBattery === state?.onBattery && next?.percent === state?.percent) return;
      state = next;
      opts.onChange();
    },
    start() {
      timer = setInterval(
        () => void watcher.poll().catch((err: unknown) => opts.onError(err as Error)),
        opts.intervalMs ?? 60_000,
      );
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
  return watcher;
}
