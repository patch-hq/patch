// How this machine is coping, sampled for the host's heartbeat to the server
// (spec/03 § Host health). Memory and swap come from /proc/meminfo, so they are
// only reported on Linux: a platform that cannot measure a thing leaves it out
// rather than guessing, and the server judges only what it was told.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { basename } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import {
  assessHostHealth,
  HOST_HEALTH_INTERVAL_MS,
  type HostHealthEvent,
  type HostProcessGroup,
} from '@patch/wire';

/** Interpreters whose own name says nothing about what they are running. */
const RUNTIMES = new Set(['node', 'python', 'python3', 'bun', 'deno', 'ruby', 'java']);

export interface MemInfo {
  memTotalBytes: number;
  memAvailableBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
}

export function parseMeminfo(text: string): MemInfo {
  const kb = (key: string): number => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text);
    if (!m) throw new Error(`/proc/meminfo has no ${key}`);
    return Number(m[1]) * 1024;
  };
  return {
    memTotalBytes: kb('MemTotal'),
    memAvailableBytes: kb('MemAvailable'),
    swapTotalBytes: kb('SwapTotal'),
    swapUsedBytes: kb('SwapTotal') - kb('SwapFree'),
  };
}

/** Group `ps -o rss=,comm=,args=` rows by what they are running, biggest first. */
export function groupProcesses(psOutput: string, limit = 5): HostProcessGroup[] {
  const groups = new Map<string, HostProcessGroup>();
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const rssBytes = Number(m[1]) * 1024;
    let name = basename(m[2]!);
    if (RUNTIMES.has(name)) {
      const script = m[3]!
        .split(/\s+/)
        .slice(1)
        .find((a) => a !== '' && !a.startsWith('-'));
      if (script) name = basename(script).replace(/\.(m?js|cjs|py)$/, '');
    }
    name = name.slice(0, 64);
    const g = groups.get(name);
    if (g) {
      g.count += 1;
      g.rssBytes += rssBytes;
    } else {
      groups.set(name, { name, count: 1, rssBytes });
    }
  }
  return [...groups.values()].sort((a, b) => b.rssBytes - a.rssBytes).slice(0, limit);
}

function ps(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'rss=,comm=,args='],
      { maxBuffer: 16 * 1024 * 1024, timeout: 10_000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

export interface HealthSampler {
  /** The current report. Resets the event-loop high-water mark. */
  sample(): Promise<Omit<HostHealthEvent, 'type' | 'hostId'>>;
  stop(): void;
}

export function createHealthSampler(): HealthSampler {
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  return {
    async sample() {
      const eventLoopLagMs = loop.max / 1e6;
      loop.reset();
      const base = {
        load1: loadavg()[0]!,
        cpuCount: Math.max(1, cpus().length),
        eventLoopLagMs,
        intervalMs: HOST_HEALTH_INTERVAL_MS,
      };
      if (process.platform !== 'linux') return { ...base, topProcesses: [] };
      const mem = parseMeminfo(await readFile('/proc/meminfo', 'utf8'));
      const report = { ...base, ...mem };
      // Naming the culprits costs a process listing, so only when memory is short.
      const topProcesses = assessHostHealth(report).reasons.includes('memory')
        ? groupProcesses(await ps())
        : [];
      return { ...report, topProcesses };
    },
    stop() {
      loop.disable();
    },
  };
}
