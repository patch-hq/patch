// Turns outlive the host (spec/02 § Turns outlive the host): a real runner
// process, a fake claude, and a second `DurableTurn` standing in for the host
// that comes up after a restart.

import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, uptime } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import {
  DurableTurn,
  detachDurableTurns,
  hasDurableTurn,
  inspectTurn,
  mapHookIds,
  OFFSET_FIELD,
  resetDurableTurnsForTest,
  retireTurn,
  tagLine,
  versionDirsInUse,
  type DurableTurnConfig,
} from '../src/durableTurn.js';
import { RUNNER_PROTOCOL } from '../src/turnRunner.js';
import { pruneOldVersions } from '../src/installer/main.js';

const here = dirname(fileURLToPath(import.meta.url));
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function configIn(root: string): DurableTurnConfig {
  return {
    turnsDir: join(root, 'turns'),
    runner: {
      command: process.execPath,
      args: ['--import', tsx, resolve(here, '../src/bin/turn-runner.ts')],
    },
  };
}

const spawnOpts = {
  command: process.execPath,
  args: [resolve(here, 'fixtures/fake-claude.mjs')],
  cwd: '',
  env: { ...process.env } as Record<string, string | undefined>,
  signal: new AbortController().signal,
};

/** Drive a SpawnedProcess the way the SDK does: lines in, lines out. */
function drive(proc: SpawnedProcess) {
  const lines: Array<Record<string, unknown>> = [];
  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (c: string) => {
    buf += c;
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      lines.push(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
    }
  });
  const exited = new Promise<void>((r) => proc.once('exit', () => r()));
  return {
    lines,
    exited,
    send: (o: unknown): void => void proc.stdin.write(`${JSON.stringify(o)}\n`),
    until: async (pred: () => boolean, what: string): Promise<void> => {
      for (let i = 0; i < 400; i++) {
        if (pred()) return;
        await sleep(25);
      }
      throw new Error(`timed out waiting for ${what}`);
    },
  };
}

const initialize = (id: string) => ({
  type: 'control_request',
  request_id: id,
  request: { subtype: 'initialize', hooks: null },
});
const prompt = { type: 'user', message: { role: 'user', content: 'hi' } };
const texts = (lines: Array<Record<string, unknown>>): unknown[] =>
  lines.filter((l) => l['type'] === 'assistant').map((l) => l['text']);

let root: string;
function fresh(): { cfg: DurableTurnConfig; cwd: string } {
  root = mkdtempSync(join(tmpdir(), 'patch-durable-'));
  const cwd = join(root, 'cwd');
  mkdirSync(cwd);
  return { cfg: configIn(root), cwd };
}

afterEach(() => {
  resetDurableTurnsForTest();
});

describe('a durable turn', () => {
  it('runs claude under a runner and removes its directory when the turn ends', async () => {
    const { cfg, cwd } = fresh();
    const turn = new DurableTurn({ config: cfg, chatId: 'c1', localId: 'L1', log });
    const d = drive(turn.spawn({ ...spawnOpts, cwd }));
    d.send(initialize('r1'));
    d.send(prompt);
    await d.until(() => texts(d.lines).includes('a1'), 'a1');
    expect(hasDurableTurn('c1')).toBe(true);
    expect(inspectTurn(cfg, 'c1')?.state).toBe('live');
    writeFileSync(join(cwd, 'go'), '');
    await d.until(() => d.lines.some((l) => l['type'] === 'result'), 'result');
    d.send({ type: 'control_request', request_id: 'x', request: { subtype: 'noop' } });
    await d.exited;
    turn.release();
    expect(texts(d.lines)).toEqual(['a1', 'a2']);
    expect(existsSync(turn.dir)).toBe(false);
    expect(hasDurableTurn('c1')).toBe(false);
  }, 20000);

  it('survives the host going away and is picked up, without repeats, by the next one', async () => {
    const { cfg, cwd } = fresh();
    const first = new DurableTurn({
      config: cfg,
      chatId: 'c2',
      localId: 'L2',
      accountId: 'work',
      log,
    });
    const d1 = drive(first.spawn({ ...spawnOpts, cwd }));
    d1.send(initialize('r1'));
    d1.send(prompt);
    await d1.until(() => texts(d1.lines).includes('a1'), 'a1');
    const a1 = d1.lines.find((l) => l['text'] === 'a1');
    const offset = a1?.[OFFSET_FIELD] as number;
    expect(offset).toBeGreaterThan(0);
    // The host handled a1, then went down.
    first.noteConsumed(offset, -1, true);
    detachDurableTurns();
    resetDurableTurnsForTest();
    expect(inspectTurn(cfg, 'c2')).toMatchObject({
      state: 'live',
      localId: 'L2',
      accountId: 'work',
      consumed: { offset, envelopes: -1 },
    });

    // The runner and claude carry on with no host; claude finishes meanwhile.
    writeFileSync(join(cwd, 'go'), '');
    await sleep(300);

    const disk = inspectTurn(cfg, 'c2');
    const second = new DurableTurn({
      config: cfg,
      chatId: 'c2',
      localId: 'L2',
      attach: { consumed: disk?.consumed ?? null },
      log,
    });
    const d2 = drive(second.spawn({ ...spawnOpts, cwd }));
    d2.send(initialize('NEW'));
    d2.send(prompt);
    await d2.exited;
    // claude was not re-initialised or re-prompted: its first answer comes back
    // under the new request id, the prompt is dropped, and everything it has
    // said replays with offsets the new host skips by.
    const init = d2.lines.find((l) => l['type'] === 'control_response');
    expect((init?.['response'] as { request_id: string }).request_id).toBe('NEW');
    expect(readFileSync(join(cwd, 'prompted'), 'utf8')).toBe('1');
    expect(texts(d2.lines)).toEqual(['a1', 'a2']);
    const plans = d2.lines.map((l) => second.plan(l).skip);
    expect(plans[d2.lines.findIndex((l) => l['text'] === 'a1')]).toBe(-1);
    expect(plans[d2.lines.findIndex((l) => l['text'] === 'a2')]).toBe(0);
    second.release();
    expect(existsSync(second.dir)).toBe(false);
  }, 30000);

  it('can be reattached after claude has already exited', async () => {
    const { cfg, cwd } = fresh();
    const first = new DurableTurn({ config: cfg, chatId: 'c3', localId: 'L3', log });
    const d1 = drive(first.spawn({ ...spawnOpts, cwd }));
    d1.send(initialize('r1'));
    d1.send(prompt);
    await d1.until(() => texts(d1.lines).includes('a1'), 'a1');
    detachDurableTurns();
    resetDurableTurnsForTest();
    writeFileSync(join(cwd, 'go'), '');
    for (let i = 0; i < 200 && inspectTurn(cfg, 'c3')?.state !== 'exited'; i++) await sleep(25);
    expect(inspectTurn(cfg, 'c3')?.state).toBe('exited');

    const second = new DurableTurn({
      config: cfg,
      chatId: 'c3',
      attach: { consumed: null },
      log,
    });
    const d2 = drive(second.spawn({ ...spawnOpts, cwd }));
    d2.send(initialize('NEW'));
    await d2.exited;
    expect(texts(d2.lines)).toEqual(['a1', 'a2']);
    expect(d2.lines.some((l) => l['type'] === 'result')).toBe(true);
    second.release();
  }, 30000);

  it('reattaching to a finished turn leaves the SDK nothing it would throw on when it writes the prompt', async () => {
    // Lived failure (8 Nov 2026): the SDK writes the user prompt right after
    // `initialize`. Its transport throws "Cannot write to terminated process"
    // when `process.exitCode !== null` and stdin is still open — and replaying
    // a finished turn sets exitCode at once. The turn then died with a banner.
    const { cfg, cwd } = fresh();
    const first = new DurableTurn({ config: cfg, chatId: 'c3w', localId: 'L3w', log });
    const d1 = drive(first.spawn({ ...spawnOpts, cwd }));
    d1.send(initialize('r1'));
    d1.send(prompt);
    await d1.until(() => texts(d1.lines).includes('a1'), 'a1');
    detachDurableTurns();
    resetDurableTurnsForTest();
    writeFileSync(join(cwd, 'go'), '');
    for (let i = 0; i < 200 && inspectTurn(cfg, 'c3w')?.state !== 'exited'; i++) await sleep(25);

    const second = new DurableTurn({ config: cfg, chatId: 'c3w', attach: { consumed: null }, log });
    const proc = second.spawn({ ...spawnOpts, cwd });
    const d2 = drive(proc);
    d2.send(initialize('NEW'));
    const sdkWouldThrow = (): boolean =>
      !proc.stdin.writableEnded && (proc.killed || proc.exitCode !== null);
    expect(sdkWouldThrow()).toBe(false);
    d2.send(prompt);
    await d2.exited;
    expect(sdkWouldThrow()).toBe(false);
    second.release();
  }, 30000);

  it('a replaced turn releasing leaves the newer turn of the same chat running', async () => {
    const { cfg, cwd } = fresh();
    const first = new DurableTurn({ config: cfg, chatId: 'c5', localId: 'L5a', log });
    const d1 = drive(first.spawn({ ...spawnOpts, cwd }));
    d1.send(initialize('r1'));
    d1.send(prompt);
    await d1.until(() => texts(d1.lines).includes('a1'), 'first a1');
    // A new message arrives before the first turn has been released.
    const second = new DurableTurn({ config: cfg, chatId: 'c5', localId: 'L5b', log });
    const d2 = drive(second.spawn({ ...spawnOpts, cwd }));
    d2.send(initialize('r1'));
    d2.send(prompt);
    await d2.until(() => texts(d2.lines).includes('a1'), 'second a1');
    first.release();
    // Past the 5s the replaced turn gives its runner before retiring it.
    await sleep(5600);
    expect(existsSync(second.dir)).toBe(true);
    expect(inspectTurn(cfg, 'c5')?.state).toBe('live');
    writeFileSync(join(cwd, 'go'), '');
    await d2.until(() => d2.lines.some((l) => l['type'] === 'result'), 'second result');
    d2.send({ type: 'control_request', request_id: 'x', request: { subtype: 'noop' } });
    await d2.exited;
    second.release();
    expect(existsSync(second.dir)).toBe(false);
  }, 30000);

  it('keeps runner.log when the runner dies without reporting claude exit', async () => {
    const { cfg, cwd } = fresh();
    const turn = new DurableTurn({ config: cfg, chatId: 'c7', localId: 'L7', log });
    const proc = turn.spawn({ ...spawnOpts, cwd });
    proc.on('error', () => undefined);
    const d = drive(proc);
    d.send(initialize('r1'));
    d.send(prompt);
    await d.until(() => texts(d.lines).includes('a1'), 'a1');
    const info = JSON.parse(readFileSync(join(turn.dir, 'runner.json'), 'utf8')) as {
      pid: number;
      claudePid: number;
    };
    writeFileSync(join(turn.dir, 'runner.log'), 'runner stderr marker\n');
    process.kill(info.pid, 'SIGKILL');
    await sleep(300);
    turn.release();
    await sleep(6000);
    expect(existsSync(turn.dir)).toBe(false);
    const kept = join(root, 'turn-failures');
    const files = readdirSync(kept);
    expect(files).toHaveLength(1);
    expect(readFileSync(join(kept, files[0] as string), 'utf8')).toContain('runner stderr marker');
  }, 30000);

  it('a claude that exits with no result: describeCut reports its exit and keeps its stderr', async () => {
    const { cfg, cwd } = fresh();
    const turn = new DurableTurn({ config: cfg, chatId: 'c8', localId: 'L8', log });
    const d = drive(turn.spawn({ ...spawnOpts, cwd }));
    d.send(initialize('r1'));
    d.send(prompt);
    await d.until(() => texts(d.lines).includes('a1'), 'a1');
    writeFileSync(join(cwd, 'die'), '');
    await d.exited;
    expect(d.lines.some((l) => l['type'] === 'result')).toBe(false);
    expect(turn.describeCut()).toBe('claude exited code=0 signal=null');
    turn.release();
    const kept = join(root, 'turn-failures');
    const files = readdirSync(kept);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/-cut\.log$/);
    expect(readFileSync(join(kept, files[0] as string), 'utf8')).toContain(
      'fake claude stderr marker',
    );
  }, 30000);

  it('retireTurn ends a runner and claude and removes the directory', async () => {
    const { cfg, cwd } = fresh();
    const turn = new DurableTurn({ config: cfg, chatId: 'c4', localId: 'L4', log });
    const d = drive(turn.spawn({ ...spawnOpts, cwd }));
    d.send(initialize('r1'));
    d.send(prompt);
    await d.until(() => texts(d.lines).includes('a1'), 'a1');
    const info = JSON.parse(readFileSync(join(turn.dir, 'runner.json'), 'utf8')) as {
      pid: number;
      claudePid: number;
    };
    detachDurableTurns();
    retireTurn(turn.dir);
    await sleep(200);
    expect(existsSync(turn.dir)).toBe(false);
    for (const pid of [info.pid, info.claudePid]) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
  }, 20000);

  it('a turn replaced by a newer one of the same chat ends as killed, not as an unexplained runner exit', async () => {
    const { cfg, cwd } = fresh();
    const first = new DurableTurn({ config: cfg, chatId: 'c-dup', localId: 'L1', log });
    const p1 = first.spawn({ ...spawnOpts, cwd });
    const errors: Error[] = [];
    p1.on('error', (e) => errors.push(e));
    const ended = new Promise<void>((r) => p1.once('exit', () => r()));
    const second = new DurableTurn({ config: cfg, chatId: 'c-dup', localId: 'L2', log });
    const d2 = drive(second.spawn({ ...spawnOpts, cwd }));
    await ended;
    expect(errors).toEqual([]);
    d2.send(initialize('r1'));
    d2.send(prompt);
    await d2.until(() => texts(d2.lines).includes('a1'), 'a1');
    retireTurn(second.dir);
  }, 20000);

  it('ends a turn nobody is attached to once claude has been silent too long', async () => {
    const { cfg, cwd } = fresh();
    process.env['PATCH_TURN_ORPHAN_IDLE_MS'] = '800';
    try {
      const turn = new DurableTurn({ config: cfg, chatId: 'c6', localId: 'L6', log });
      const d = drive(turn.spawn({ ...spawnOpts, cwd }));
      d.send(initialize('r1'));
      d.send(prompt);
      await d.until(() => texts(d.lines).includes('a1'), 'a1');
      // The host goes and never comes back; claude is left waiting for `go`.
      detachDurableTurns();
      for (let i = 0; i < 200 && inspectTurn(cfg, 'c6')?.state !== 'exited'; i++) await sleep(50);
      expect(inspectTurn(cfg, 'c6')?.state).toBe('exited');
    } finally {
      delete process.env['PATCH_TURN_ORPHAN_IDLE_MS'];
    }
  }, 30000);

  it('reports a turn whose runner was killed as lost', () => {
    const { cfg } = fresh();
    const dir = join(cfg.turnsDir, 'c5');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'turn.json'), JSON.stringify({ chatId: 'c5', localId: 'L5' }));
    writeFileSync(join(dir, 'runner.json'), JSON.stringify({ pid: 2 ** 22 + 1, claudePid: null }));
    expect(inspectTurn(cfg, 'c5')?.state).toBe('lost');
  });
});

describe('a runner record from before a reboot', () => {
  it('is lost even when its pid now belongs to another process and the socket file remains', () => {
    const { cfg } = fresh();
    const dir = join(cfg.turnsDir, 'rb1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'turn.json'), JSON.stringify({ chatId: 'rb1', localId: 'L' }));
    const info = join(dir, 'runner.json');
    writeFileSync(info, JSON.stringify({ pid: process.pid, claudePid: null }));
    writeFileSync(join(dir, 's'), '');
    expect(inspectTurn(cfg, 'rb1')?.state).toBe('live');
    const old = new Date(Date.now() - (uptime() + 3600) * 1000);
    utimesSync(info, old, old);
    expect(inspectTurn(cfg, 'rb1')?.state).toBe('lost');
  });
});

describe('runner protocol version', () => {
  it('a runner states its protocol in runner.json, and the host reads it', async () => {
    const { cfg, cwd } = fresh();
    const turn = new DurableTurn({ config: cfg, chatId: 'p1', localId: 'LP', log });
    const d = drive(turn.spawn({ ...spawnOpts, cwd }));
    d.send(initialize('r1'));
    d.send(prompt);
    await d.until(() => texts(d.lines).includes('a1'), 'a1');
    expect(JSON.parse(readFileSync(join(turn.dir, 'runner.json'), 'utf8')).protocol).toBe(
      RUNNER_PROTOCOL,
    );
    expect(inspectTurn(cfg, 'p1')?.protocol).toBe(RUNNER_PROTOCOL);
    detachDurableTurns();
    resetDurableTurnsForTest();
    writeFileSync(join(cwd, 'go'), '');
    for (let i = 0; i < 200 && inspectTurn(cfg, 'p1')?.state !== 'exited'; i++) await sleep(25);
  }, 30000);

  it('a runner from before the field speaks protocol 1', () => {
    const { cfg } = fresh();
    const dir = join(cfg.turnsDir, 'p2');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'turn.json'), JSON.stringify({ chatId: 'p2' }));
    writeFileSync(join(dir, 'runner.json'), JSON.stringify({ pid: process.pid, claudePid: null }));
    writeFileSync(join(dir, 's'), '');
    expect(inspectTurn(cfg, 'p2')?.protocol).toBe(1);
  });

  it('refuses, loudly, to reattach to a runner speaking a protocol it does not know', () => {
    const { cfg, cwd } = fresh();
    const dir = join(cfg.turnsDir, 'p3');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'turn.json'), JSON.stringify({ chatId: 'p3' }));
    writeFileSync(
      join(dir, 'runner.json'),
      JSON.stringify({ pid: process.pid, protocol: 999, claudePid: null }),
    );
    writeFileSync(join(dir, 's'), '');
    const turn = new DurableTurn({ config: cfg, chatId: 'p3', attach: { consumed: null }, log });
    expect(() => turn.spawn({ ...spawnOpts, cwd })).toThrow(/protocol 999/);
  });
});

describe('durable turn helpers', () => {
  it('tags a line with its offset and leaves empty objects alone', () => {
    expect(tagLine('{"a":1}', 9)).toBe(`{"${OFFSET_FIELD}":9,"a":1}`);
    expect(tagLine('{}', 9)).toBe('{}');
    expect(tagLine('nope', 9)).toBe('nope');
  });

  it('maps hook ids position by position and drops ones with no counterpart', () => {
    const oldH = { PreToolUse: [{ hookCallbackIds: ['hook_0', 'hook_1'] }] };
    const newH = { PreToolUse: [{ hookCallbackIds: ['hook_5'] }] };
    expect([...mapHookIds(oldH, newH)]).toEqual([['hook_0', 'hook_5']]);
  });

  it('keeps an install folder a live runner started from when pruning', () => {
    const base = mkdtempSync(join(tmpdir(), 'patch-prune-'));
    const versions = join(base, 'versions');
    for (const v of ['v1', 'v2', 'v3', 'v4']) {
      mkdirSync(join(versions, v, 'dist'), { recursive: true });
    }
    const turns = join(base, 'turns');
    mkdirSync(join(turns, 'c'), { recursive: true });
    writeFileSync(
      join(turns, 'c', 'runner.json'),
      JSON.stringify({ pid: process.pid, script: join(versions, 'v1', 'dist', 'turn-runner.js') }),
    );
    const inUse = versionDirsInUse(turns, versions);
    expect([...inUse]).toEqual([join(versions, 'v1')]);
    pruneOldVersions(versions, join(versions, 'v4'), inUse);
    expect(existsSync(join(versions, 'v1'))).toBe(true);
    expect(existsSync(join(versions, 'v4'))).toBe(true);
  });
});
