// Turns outlive the host (spec/02 § Turns outlive the host): a real runner
// process, a fake claude, and a second `DurableTurn` standing in for the host
// that comes up after a restart.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

  it('reports a turn whose runner was killed as lost', () => {
    const { cfg } = fresh();
    const dir = join(cfg.turnsDir, 'c5');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'turn.json'), JSON.stringify({ chatId: 'c5', localId: 'L5' }));
    writeFileSync(join(dir, 'runner.json'), JSON.stringify({ pid: 2 ** 22 + 1, claudePid: null }));
    expect(inspectTurn(cfg, 'c5')?.state).toBe('lost');
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
