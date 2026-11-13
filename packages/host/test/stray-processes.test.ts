import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WireEvent } from '@patch/wire';
import {
  StrayProcessTracker,
  handleStrayProcessesRequest,
  type StrayDeps,
} from '../src/strayProcesses.js';

// spec/02 § Stray processes — a fixture /proc: the tracker reads real file
// shapes (`stat`, `environ`, `cmdline`) so the parsing is the production path.

let root: string;
let now: number;
const killed: Array<[number, string]> = [];

function addProc(
  pid: number,
  o: { ppid: number; comm: string; chat?: string; cmd?: string; startTicks?: number },
): void {
  const dir = join(root, String(pid));
  mkdirSync(dir, { recursive: true });
  const fields = Array.from({ length: 30 }, () => '0');
  fields[0] = 'S';
  fields[1] = String(o.ppid);
  fields[19] = String(o.startTicks ?? 1000);
  writeFileSync(join(dir, 'stat'), `${pid} (${o.comm}) ${fields.join(' ')}`);
  writeFileSync(join(dir, 'environ'), o.chat ? `HOME=/x\0PATCH_CHAT_ID=${o.chat}\0` : 'HOME=/x\0');
  writeFileSync(join(dir, 'cmdline'), (o.cmd ?? o.comm).split(' ').join('\0') + '\0');
}

function deps(): StrayDeps {
  return { procRoot: root, now: () => now, kill: (pid, sig) => void killed.push([pid, sig]) };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fake-proc-'));
  writeFileSync(join(root, 'stat'), 'cpu 1 2 3\nbtime 1000\n');
  now = 5_000_000;
  killed.length = 0;
  addProc(1, { ppid: 0, comm: 'systemd' });
  addProc(50, { ppid: 40, comm: 'node' }); // the host
  addProc(100, { ppid: 50, comm: 'claude', chat: 'c1' }); // the agent: parent is the host
  addProc(101, { ppid: 100, comm: 'mcp', chat: 'c1' }); // its MCP server
  addProc(102, { ppid: 100, comm: 'bash', chat: 'c1' }); // a running foreground command
  addProc(103, { ppid: 102, comm: 'sleep', chat: 'c1' }); // its child
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('StrayProcessTracker', () => {
  it('reports nothing while every process is inside the chat tree', () => {
    expect(new StrayProcessTracker(deps()).list('c1')).toEqual([]);
  });

  it('lists a process adopted by init after its shell exited, with command and start time', () => {
    addProc(200, {
      ppid: 1,
      comm: 'node',
      chat: 'c1',
      cmd: 'node long-run.js --flag',
      startTicks: 6000,
    });
    const rows = new StrayProcessTracker(deps()).list('c1');
    expect(rows).toEqual([
      { pid: 200, command: 'node long-run.js --flag', startedAt: 1_060_000, running: true },
    ]);
  });

  it('also catches one adopted by a systemd --user subreaper', () => {
    addProc(60, { ppid: 1, comm: 'systemd' });
    addProc(201, { ppid: 60, comm: 'python3', chat: 'c1' });
    expect(new StrayProcessTracker(deps()).list('c1').map((r) => r.pid)).toEqual([201]);
  });

  it('ignores other chats, and processes carrying no chat id', () => {
    addProc(202, { ppid: 1, comm: 'a', chat: 'other' });
    addProc(203, { ppid: 1, comm: 'b' });
    expect(new StrayProcessTracker(deps()).list('c1')).toEqual([]);
  });

  it('keeps a stray after it exits, marked not running with when it was noticed gone', () => {
    addProc(200, { ppid: 1, comm: 'node', chat: 'c1' });
    const t = new StrayProcessTracker(deps());
    expect(t.list('c1')[0]?.running).toBe(true);
    rmSync(join(root, '200'), { recursive: true });
    now += 1234;
    const rows = t.list('c1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pid: 200, running: false, endedAt: now });
  });

  it('a reused pid is a new process, not the old one resurrected', () => {
    addProc(200, { ppid: 1, comm: 'node', chat: 'c1', startTicks: 1000 });
    const t = new StrayProcessTracker(deps());
    t.list('c1');
    addProc(200, { ppid: 1, comm: 'node', chat: 'c1', startTicks: 9000 });
    const rows = t.list('c1');
    expect(rows.map((r) => r.running).sort()).toEqual([false, true]);
  });

  it('stop signals the stray and its descendants, and refuses a pid that is not a stray', () => {
    addProc(200, { ppid: 1, comm: 'sh', chat: 'c1' });
    addProc(210, { ppid: 200, comm: 'worker', chat: 'c1' });
    const t = new StrayProcessTracker(deps());
    expect(t.stop('c1', 100)).toBe(false); // the agent itself
    expect(t.stop('c1', 999)).toBe(false);
    expect(killed).toEqual([]);
    expect(t.stop('c1', 200)).toBe(true);
    expect(killed).toEqual([
      [210, 'SIGTERM'],
      [200, 'SIGTERM'],
    ]);
  });

  it('fails loudly where there is no /proc', () => {
    const t = new StrayProcessTracker({ ...deps(), procRoot: join(root, 'missing') });
    expect(() => t.list('c1')).toThrow(/only available on Linux/);
  });
});

describe('handleStrayProcessesRequest', () => {
  const logger = { warn: vi.fn() } as never;
  const run = (ev: object, tracker: StrayProcessTracker, has = true): WireEvent => {
    const out: WireEvent[] = [];
    handleStrayProcessesRequest(
      { type: 'patch.stray_processes.request', requestId: 'r', chatId: 'c1', ...ev } as never,
      tracker,
      () => has,
      (e) => out.push(e),
      logger,
    );
    return out[0] as WireEvent;
  };

  it('answers the list, and stop-then-list in one round trip', () => {
    addProc(200, { ppid: 1, comm: 'sh', chat: 'c1' });
    const t = new StrayProcessTracker(deps());
    expect(run({}, t)).toMatchObject({ ok: true, processes: [{ pid: 200 }] });
    expect(run({ stopPid: 200 }, t)).toMatchObject({ ok: true, stopped: true });
  });

  it('reports an unknown chat and an unsupported host as errors, not as empty lists', () => {
    const t = new StrayProcessTracker(deps());
    expect(run({}, t, false)).toMatchObject({ ok: false, error: { code: 'chat_not_found' } });
    const noProc = new StrayProcessTracker({ ...deps(), procRoot: join(root, 'missing') });
    expect(run({}, noProc)).toMatchObject({ ok: false, error: { code: 'unsupported_platform' } });
  });
});
