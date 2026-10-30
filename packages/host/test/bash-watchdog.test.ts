import { describe, expect, it, vi } from 'vitest';
import {
  BashWatchdog,
  DEFAULT_BASH_TIMEOUT_MS,
  GRACE_MS,
  KILL_WAIT_MS,
  MAX_BASH_TIMEOUT_MS,
  TERM_WAIT_MS,
  bashTimeoutMs,
  groupsUnder,
  type ProcRow,
} from '../src/bashWatchdog.js';

const claude: ProcRow = { pid: 10, ppid: 1, pgid: 10, command: 'claude' };
const mcp: ProcRow = { pid: 11, ppid: 10, pgid: 10, command: 'mcp-server' };
const shell = (pgid: number, cmd: string): ProcRow[] => [
  { pid: pgid, ppid: 10, pgid, command: `zsh -c eval '${cmd}'` },
  { pid: pgid + 1, ppid: pgid, pgid, command: 'ls ~/Documents' },
];

describe('bashTimeoutMs', () => {
  it('applies Claude Code defaults and cap', () => {
    expect(bashTimeoutMs({})).toBe(DEFAULT_BASH_TIMEOUT_MS);
    expect(bashTimeoutMs({ timeout: 60000 })).toBe(60000);
    expect(bashTimeoutMs({ timeout: 9e9 })).toBe(MAX_BASH_TIMEOUT_MS);
    expect(bashTimeoutMs({ timeout: -1 })).toBe(DEFAULT_BASH_TIMEOUT_MS);
  });
});

describe('groupsUnder', () => {
  it('leaves claude’s own group alone', () => {
    const g = groupsUnder([claude, mcp, ...shell(500, 'ls')], 10);
    expect([...g.keys()]).toEqual([500]);
  });
});

describe('BashWatchdog', () => {
  function setup(rows: () => ProcRow[]) {
    vi.useFakeTimers();
    const sent: Array<[number, string]> = [];
    const announce = vi.fn();
    const dead = new Set<number>();
    const dog = new BashWatchdog({
      rootPid: () => 10,
      list: async () => rows().filter((r) => !dead.has(r.pgid) || r.pgid === 10),
      killGroup: (g, s) => {
        sent.push([g, s]);
        return true;
      },
      announce,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
    });
    return { dog, sent, announce, dead };
  }

  it('does nothing when the call returns in time', async () => {
    const live: ProcRow[] = [claude, mcp];
    const { dog, sent, announce } = setup(() => live);
    await dog.started('a', { command: 'ls', timeout: 1000 });
    live.push(...shell(500, 'ls'));
    dog.finished('a');
    await vi.advanceTimersByTimeAsync(1000 + GRACE_MS + 60_000);
    expect(sent).toEqual([]);
    expect(announce).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('TERMs then KILLs the hung call’s group, not older groups', async () => {
    const live: ProcRow[] = [claude, mcp, ...shell(300, 'old-bg')];
    const { dog, sent, announce } = setup(() => live);
    await dog.started('a', { command: 'ls ~/Documents', timeout: 1000 });
    live.push(...shell(500, 'ls ~/Documents'));
    await vi.advanceTimersByTimeAsync(1000 + GRACE_MS);
    expect(sent).toEqual([[500, 'SIGTERM']]);
    await vi.advanceTimersByTimeAsync(TERM_WAIT_MS);
    expect(sent).toEqual([
      [500, 'SIGTERM'],
      [500, 'SIGKILL'],
    ]);
    await vi.advanceTimersByTimeAsync(KILL_WAIT_MS);
    const last = announce.mock.calls.at(-1)![0] as string;
    expect(last).toMatch(/would not die/);
    vi.useRealTimers();
  });

  it('stops escalating once the call returns', async () => {
    const live: ProcRow[] = [claude];
    const { dog, sent } = setup(() => live);
    await dog.started('a', { command: 'ls', timeout: 1000 });
    live.push(...shell(500, 'ls'));
    await vi.advanceTimersByTimeAsync(1000 + GRACE_MS);
    dog.finished('a');
    await vi.advanceTimersByTimeAsync(TERM_WAIT_MS + KILL_WAIT_MS);
    expect(sent).toEqual([[500, 'SIGTERM']]);
    vi.useRealTimers();
  });

  it('does not watch background calls', async () => {
    const { dog, sent } = setup(() => [claude]);
    await dog.started('a', { command: 'sleep 9999', run_in_background: true });
    await vi.advanceTimersByTimeAsync(MAX_BASH_TIMEOUT_MS + 60_000);
    expect(sent).toEqual([]);
    vi.useRealTimers();
  });

  it('with two calls in flight kills only the one whose command matches', async () => {
    const live: ProcRow[] = [claude];
    const { dog, sent } = setup(() => live);
    await dog.started('a', { command: 'slow-thing', timeout: 1000 });
    live.push(...shell(500, 'slow-thing'));
    await dog.started('b', { command: 'other', timeout: 600000 });
    live.push(...shell(600, 'other'));
    await vi.advanceTimersByTimeAsync(1000 + GRACE_MS);
    expect(sent).toEqual([[500, 'SIGTERM']]);
    dog.stop();
    vi.useRealTimers();
  });
});
