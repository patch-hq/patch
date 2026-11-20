// Terminal sessions, PTY and pipe alike, survive a host restart (spec/02 §
// Terminal sessions, § Host restarts). Real python3 runner, real PTY, real shell, a real second
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

describe('pipe sessions across a host restart', { timeout: 30_000 }, () => {
  let dir: string;
  let runDir: string;
  const hosts: TerminalSessions[] = [];

  const host = (s: ReturnType<typeof sink>) => {
    const h = new TerminalSessions({ runDir, emit: s.emit });
    hosts.push(h);
    return h;
  };
  const waitFor = async (what: string, ok: () => boolean): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (!ok()) {
      if (Date.now() > deadline) throw new Error(`never saw ${what}`);
      await sleep(20);
    }
  };
  const until = (s: ReturnType<typeof sink>, needle: string) =>
    waitFor(JSON.stringify(needle), () => s.text().includes(needle));
  const open = async (h: TerminalSessions, s: ReturnType<typeof sink>): Promise<void> => {
    h.handle({
      type: 'patch.terminal.open',
      hostId: 'h1',
      sessionId: 'w1',
      folder: dir,
      forSurfaceId: 'web',
    });
    await waitFor('ready', () => s.frames.some((f) => f.type === 'patch.terminal.ready'));
  };
  const run = (h: TerminalSessions, data: string) =>
    h.handle({ type: 'patch.terminal.input', sessionId: 'w1', data });
  const commandExits = (s: ReturnType<typeof sink>): number[] =>
    s.frames
      .filter((f) => f.type === 'patch.terminal.command-exit')
      .map((f) => (f as Extract<WireEvent, { type: 'patch.terminal.command-exit' }>).code);
  const streamOf = (s: ReturnType<typeof sink>, needle: string): string | undefined =>
    (
      s.frames.find((f) => f.type === 'patch.terminal.output' && f.data.includes(needle)) as
        | Extract<WireEvent, { type: 'patch.terminal.output' }>
        | undefined
    )?.stream;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-piper-'));
    runDir = join(dir, '.terminals');
  });

  afterEach(async () => {
    for (const h of hosts.splice(0)) await h.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the same shell, its state, its streams and its completion reports', async () => {
    const first = sink();
    const h1 = host(first);
    await open(h1, first);
    run(h1, 'KEPT=nine; cd /\n');
    run(h1, 'echo before-$((4+5))\n');
    await until(first, 'before-9');
    await waitFor('two completions', () => commandExits(first).length === 2);

    await h1.shutdown(); // the host goes down
    expect(first.exits()).toEqual([]);

    const second = sink();
    const h2 = host(second);
    expect(await h2.adopt()).toBe(1);
    run(h2, 'echo after-$KEPT-$(pwd)\n');
    run(h2, 'echo oops-$KEPT 1>&2; false\n');
    await until(second, 'after-nine-/');
    await until(second, 'oops-nine');
    expect(streamOf(second, 'after-nine')).toBe('stdout');
    expect(streamOf(second, 'oops-nine')).toBe('stderr');
    // The reattached host still knows the shell's sentinel: it reports each
    // command's status and never shows the marker as output.
    await waitFor('both completions', () => commandExits(second).length === 2);
    expect(commandExits(second)).toEqual([0, 1]);
    expect(second.text()).not.toContain('__patch_exit_');
    // What the first host delivered is not delivered again.
    expect(second.text()).not.toContain('before-9');
    expect(
      second.frames.every((f) => (f as { forSurfaceId?: string }).forSurfaceId === 'web'),
    ).toBe(true);
  });

  it('delivers what the shell printed while no host was there, each on its own stream', async () => {
    const first = sink();
    const h1 = host(first);
    await open(h1, first);
    run(h1, '(sleep 1; echo away-out-$((6*7)); echo away-err-$((6*7)) 1>&2) &\n');
    await sleep(200);
    await h1.shutdown();
    await sleep(1800);

    const second = sink();
    const h2 = host(second);
    expect(await h2.adopt()).toBe(1);
    await until(second, 'away-out-42');
    await until(second, 'away-err-42');
    expect(streamOf(second, 'away-out-42')).toBe('stdout');
    expect(streamOf(second, 'away-err-42')).toBe('stderr');
  });

  it('reports a shell that ended while no host was there, with its status and last output', async () => {
    const first = sink();
    const h1 = host(first);
    await open(h1, first);
    run(h1, 'sleep 1; echo bye-$((2+2)); exit 4\n');
    await sleep(200);
    await h1.shutdown();
    await sleep(2000);

    const second = sink();
    const h2 = host(second);
    expect(await h2.adopt()).toBe(0);
    expect(second.text()).toContain('bye-4');
    expect(second.exits()).toMatchObject([
      { sessionId: 'w1', code: 4, reason: 'shell_exit', forSurfaceId: 'web' },
    ]);
    expect(existsSync(runDir) ? readdirNames(runDir) : []).toEqual([]);
  });

  it('interrupts a command started under the previous host, and the shell carries on', async () => {
    const first = sink();
    const h1 = host(first);
    await open(h1, first);
    run(h1, "sh -c 'echo up-$((40+3)); exec sleep 30'\n");
    await until(first, 'up-43');
    await h1.shutdown();

    const second = sink();
    const h2 = host(second);
    expect(await h2.adopt()).toBe(1);
    h2.handle({ type: 'patch.terminal.signal', sessionId: 'w1', signal: 'SIGINT' });
    await waitFor('the interrupted command to report', () => commandExits(second).length > 0);
    run(h2, 'echo alive-$((1+1))\n');
    await until(second, 'alive-2');
    expect(second.exits()).toEqual([]);
  });

  it('closing a reattached pipe session ends its shell', async () => {
    const first = sink();
    const h1 = host(first);
    await open(h1, first);
    await h1.shutdown();

    const second = sink();
    const h2 = host(second);
    await h2.adopt();
    h2.handle({ type: 'patch.terminal.close', sessionId: 'w1' });
    await waitFor('exit', () => second.exits().length > 0);
    expect(second.exits()).toMatchObject([{ sessionId: 'w1', reason: 'closed' }]);
    expect(readdirNames(runDir)).toEqual([]);
  });
});

function readdirNames(p: string): string[] {
  return execFileSync('ls', ['-A', p]).toString().split('\n').filter(Boolean);
}
