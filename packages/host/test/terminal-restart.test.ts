// PTY sessions survive a host restart (spec/02 § Terminal sessions, § Host
// restarts). Real python3 runner, real PTY, real shell, a real second
// `TerminalSessions` standing in for the host that starts after the first one
// went down — nothing is mocked.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WireEvent } from '@patch/wire';
import { TerminalSessions } from '../src/terminal.js';

function sink() {
  const frames: WireEvent[] = [];
  return {
    frames,
    emit: (e: WireEvent): void => void frames.push(e),
    text: (): string =>
      frames
        .filter((f) => f.type === 'patch.terminal.output')
        .map((f) => (f as Extract<WireEvent, { type: 'patch.terminal.output' }>).data)
        .join(''),
    exits: () =>
      frames.filter((f) => f.type === 'patch.terminal.exit') as Array<
        Extract<WireEvent, { type: 'patch.terminal.exit' }>
      >,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('PTY sessions across a host restart', { timeout: 30_000 }, () => {
  let dir: string;
  let runDir: string;
  let prev: { shell?: string; home?: string };
  const hosts: TerminalSessions[] = [];

  const host = (s: ReturnType<typeof sink>, extra: { orphanSeconds?: number } = {}) => {
    const h = new TerminalSessions({ runDir, emit: s.emit, ...extra });
    hosts.push(h);
    return h;
  };
  const until = async (s: ReturnType<typeof sink>, needle: string): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (!s.text().includes(needle)) {
      if (Date.now() > deadline) {
        throw new Error(`never saw ${JSON.stringify(needle)} in ${JSON.stringify(s.text())}`);
      }
      await sleep(20);
    }
  };
  const open = (h: TerminalSessions) =>
    h.handle({
      type: 'patch.terminal.open',
      hostId: 'h1',
      sessionId: 'p1',
      folder: dir,
      pty: { cols: 80, rows: 24 },
      forSurfaceId: 'phone',
    });
  const type = (h: TerminalSessions, data: string) =>
    h.handle({ type: 'patch.terminal.input', sessionId: 'p1', data });
  const ready = async (s: ReturnType<typeof sink>): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (!s.frames.some((f) => f.type === 'patch.terminal.ready')) {
      if (Date.now() > deadline) throw new Error('never ready');
      await sleep(20);
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-ptyr-'));
    runDir = join(dir, '.terminals');
    prev = { shell: process.env.SHELL, home: process.env.HOME };
    process.env.SHELL = '/bin/bash';
    process.env.HOME = dir; // a plain login shell, no profile noise
  });

  afterEach(async () => {
    for (const h of hosts.splice(0)) await h.closeAll();
    process.env.SHELL = prev.shell as string;
    process.env.HOME = prev.home as string;
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the same shell running: its state is still there and it still answers', async () => {
    const first = sink();
    const h1 = host(first);
    open(h1);
    await ready(first);
    type(h1, 'KEPT=seven\r');
    type(h1, 'echo before-$((3+4))\r');
    await until(first, 'before-7');

    await h1.shutdown(); // the host goes down

    const second = sink();
    const h2 = host(second);
    expect(await h2.adopt()).toBe(1);
    type(h2, 'echo after-$KEPT\r');
    await until(second, 'after-seven');
    // What the first host had already delivered is not delivered again.
    expect(second.text()).not.toContain('before-7');
    // Frames still go to the surface that opened the session.
    expect(
      second.frames.every((f) => (f as { forSurfaceId?: string }).forSurfaceId === 'phone'),
    ).toBe(true);
  });

  it('delivers what the shell printed while no host was there', async () => {
    const first = sink();
    const h1 = host(first);
    open(h1);
    await ready(first);
    type(h1, '(sleep 1; echo while-away-$((20+22))) &\r');
    await sleep(200);
    await h1.shutdown();
    await sleep(1800);

    const second = sink();
    const h2 = host(second);
    expect(await h2.adopt()).toBe(1);
    await until(second, 'while-away-42');
  });

  it('reports a shell that ended while no host was there, with its status and last output', async () => {
    const first = sink();
    const h1 = host(first);
    open(h1);
    await ready(first);
    type(h1, 'sleep 1; echo bye-$((1+1)); exit 3\r');
    await sleep(200);
    await h1.shutdown();
    await sleep(2000);

    const second = sink();
    const h2 = host(second);
    expect(await h2.adopt()).toBe(0);
    expect(second.text()).toContain('bye-2');
    expect(second.exits()).toMatchObject([
      { sessionId: 'p1', code: 3, reason: 'shell_exit', forSurfaceId: 'phone' },
    ]);
    expect(existsSync(runDir) ? readdirNames(runDir) : []).toEqual([]);
  });

  it('tells the surface when the runner died with the machine, rather than leaving a ghost', async () => {
    const first = sink();
    const h1 = host(first);
    open(h1);
    await ready(first);
    await h1.shutdown();
    const pids = execFileSync('pgrep', ['-f', runDir]).toString().trim().split('\n');
    for (const pid of pids) process.kill(Number(pid), 'SIGKILL');
    await sleep(200);

    const second = sink();
    const h2 = host(second);
    expect(await h2.adopt()).toBe(0);
    expect(second.exits()).toMatchObject([
      { sessionId: 'p1', code: null, reason: 'daemon_shutdown' },
    ]);
    expect(h2.count()).toBe(0);
  });

  it('a surface that opens the same session again gets the same shell with its scrollback', async () => {
    const first = sink();
    const h1 = host(first);
    open(h1);
    await ready(first);
    type(h1, 'VAR=kept-$((6*7))\r');
    type(h1, 'echo scroll-$VAR\r');
    await until(first, 'scroll-kept-42');
    await h1.shutdown();

    const second = sink();
    const h2 = host(second);
    await h2.adopt();
    open(h2);
    await until(second, 'scroll-kept-42'); // the scrollback, drawn again
    expect(second.frames.some((f) => f.type === 'patch.terminal.ready')).toBe(true);
    type(h2, 'echo again-$VAR\r');
    await until(second, 'again-kept-42');
  });

  it('closing a reattached session ends its shell', async () => {
    const first = sink();
    const h1 = host(first);
    open(h1);
    await ready(first);
    await h1.shutdown();

    const second = sink();
    const h2 = host(second);
    await h2.adopt();
    h2.handle({ type: 'patch.terminal.close', sessionId: 'p1' });
    const deadline = Date.now() + 10_000;
    while (second.exits().length === 0 && Date.now() < deadline) await sleep(20);
    expect(second.exits()).toMatchObject([{ sessionId: 'p1', reason: 'closed' }]);
    expect(readdirNames(runDir)).toEqual([]);
  });

  it('trims a huge scrollback but keeps absolute offsets, and still reattaches', async () => {
    const first = sink();
    const h1 = host(first);
    open(h1);
    await ready(first);
    // The host drops live output past a per-second cap, so the marker must
    // land in a later window than the flood or it is dropped with it.
    type(h1, "head -c 5000000 /dev/zero | tr '\\0' 'a'; echo; sleep 1.3; echo big-$((1+1))\r");
    await until(first, 'big-2');
    await h1.shutdown();
    const [name] = readdirNames(runDir);
    const base = Number(readFileSync(join(runDir, name, 'out.base'), 'utf8'));
    expect(base).toBeGreaterThan(0);

    const second = sink();
    const h2 = host(second);
    expect(await h2.adopt()).toBe(1);
    type(h2, 'echo still-$((2+3))\r');
    await until(second, 'still-5');
  });

  it('a runner nobody comes back for ends its shell instead of living for ever', async () => {
    const first = sink();
    const h1 = host(first, { orphanSeconds: 1 });
    open(h1);
    await ready(first);
    await h1.shutdown();
    await sleep(3500);

    const second = sink();
    const h2 = host(second);
    expect(await h2.adopt()).toBe(0);
    expect(second.exits()).toHaveLength(1);
  });
});

function readdirNames(p: string): string[] {
  return execFileSync('ls', ['-A', p]).toString().split('\n').filter(Boolean);
}
