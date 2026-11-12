// A host restart finds a turn still running under its runner: it reattaches to
// that turn instead of re-sending it as "cut off" (spec/02 § Turns outlive the
// host). A turn with no runner left is cut off as before.

import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { Daemon, INTERRUPTED_TURN_REMINDER, interruptedTurnResend } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { DurableTurnConfig } from '../src/durableTurn.js';
import type { SdkBackend, SdkRunOptions } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });
const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));

function host(
  home: string,
  backend: SdkBackend,
  durableTurns: DurableTurnConfig,
  events: unknown[] = [],
  logger: pino.Logger = silent,
) {
  let id = 0;
  const metaStore = createMetaStore(home);
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore,
    sdkBackend: backend,
    oauthAccessToken: 'fake-token',
    durableTurns,
    emit: (e) => void events.push(e),
    logger,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, metaStore };
}

/** What the previous host left in the turn directory. */
function leaveTurn(
  cfg: DurableTurnConfig,
  chatId: string,
  localId: string | undefined,
  state: 'live' | 'exited' | 'lost',
  consumed?: { offset: number; envelopes: number },
): string {
  const dir = join(cfg.turnsDir, chatId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'turn.json'),
    JSON.stringify({ chatId, ...(localId !== undefined ? { localId } : {}) }),
  );
  if (consumed) writeFileSync(join(dir, 'consumed.json'), JSON.stringify(consumed));
  if (state === 'exited') writeFileSync(join(dir, 'exit.json'), '{"code":0,"signal":null}');
  if (state === 'live') {
    writeFileSync(join(dir, 'runner.json'), JSON.stringify({ pid: process.pid, claudePid: null }));
    writeFileSync(join(dir, 's'), '');
  }
  return dir;
}

async function interruptedChat(
  state: 'live' | 'exited' | 'lost',
  beforeSecondHost?: (cfg: DurableTurnConfig, chatId: string) => void,
  logger: pino.Logger = silent,
) {
  const home = mkdtempSync(join(tmpdir(), 'patch-dres-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-dresf-')));
  const cfg: DurableTurnConfig = {
    turnsDir: join(home, 'turns'),
    runner: { command: 'unused', args: [] },
  };
  // The first host: a turn that never finishes.
  const gates: Array<() => void> = [];
  const firstBackend: SdkBackend = {
    async *run() {
      await new Promise<void>((r) => gates.push(r));
      yield { type: 'result', sessionId: 'sess' };
    },
  };
  const first = host(home, firstBackend, cfg);
  const chatId = await first.daemon.spawnChat({ folder });
  void first.daemon.sendInput({ chatId, message: 'first', localId: 'L0' });
  await tick();
  gates.shift()?.();
  await tick();
  void first.daemon.sendInput({ chatId, message: 'running', localId: 'L1' });
  await tick();
  const dir = leaveTurn(cfg, chatId, 'L1', state, { offset: 42, envelopes: 2 });

  const seen: SdkRunOptions[] = [];
  const secondBackend: SdkBackend = {
    async *run(opts) {
      seen.push(opts);
      yield { type: 'result', sessionId: 'sess2' };
    },
  };
  const secondEvents: unknown[] = [];
  beforeSecondHost?.(cfg, chatId);
  const second = host(home, secondBackend, cfg, secondEvents, logger);
  second.daemon.hydrate();
  await tick(60);
  return { seen, dir, chatId, cfg, secondEvents };
}

describe('resuming a turn that outlived the host', () => {
  it.each(['live', 'exited'] as const)(
    'reattaches to a %s turn and re-sends the prompt verbatim',
    async (state) => {
      const { seen, chatId, cfg } = await interruptedChat(state);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.prompt).toBe('running');
      expect(seen[0]?.prompt).not.toBe(interruptedTurnResend(INTERRUPTED_TURN_REMINDER, 'running'));
      expect(seen[0]?.durableTurn).toMatchObject({
        chatId,
        localId: 'L1',
        attach: { consumed: { offset: 42, envelopes: 2 } },
      });
      expect(seen[0]?.durableTurn?.config).toBe(cfg);
    },
  );

  // A job-fired chat's first turn is its spawn prompt, which carries no
  // localId. 2026-11-05: the re-send was given a fresh random id, the marker
  // (undefined) never matched it, and the reattach was dropped as stale — eight
  // times, each cutting the turn off.
  it('reattaches to a spawn-prompt turn that has no localId', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-dres-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-dresf-')));
    const cfg: DurableTurnConfig = {
      turnsDir: join(home, 'turns'),
      runner: { command: 'unused', args: [] },
    };
    const firstBackend: SdkBackend = {
      async *run() {
        await new Promise<void>(() => undefined);
      },
    };
    const first = host(home, firstBackend, cfg);
    const chatId = await first.daemon.spawnChat({ folder, prompt: 'job prompt' });
    await tick();
    leaveTurn(cfg, chatId, undefined, 'live', { offset: 7, envelopes: -1 });

    const seen: SdkRunOptions[] = [];
    const second = host(
      home,
      {
        async *run(opts) {
          seen.push(opts);
          yield { type: 'result', sessionId: 's2' };
        },
      },
      cfg,
    );
    second.daemon.hydrate();
    await tick(60);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.prompt).toBe('job prompt');
    expect(seen[0]?.durableTurn?.attach).toEqual({ consumed: { offset: 7, envelopes: -1 } });
  });

  it.each(['live', 'exited'] as const)(
    'adds no user message to the chat when it reattaches to a %s turn',
    async (state) => {
      const { secondEvents } = await interruptedChat(state);
      const userMessages = (secondEvents as Array<{ type: string; role?: string }>).filter(
        (e) => e.type === 'chat.message' && e.role === 'user',
      );
      expect(userMessages).toEqual([]);
    },
  );

  // 2026-11-12: an overdue wake loaded before the resend started its own turn
  // first, took the reattach marker and killed the surviving runner.
  it('reattaches the live turn first and fires an overdue wake after it, not before', async () => {
    const { seen, chatId, cfg } = await interruptedChat('live', (_cfg, id) => {
      const home = join(_cfg.turnsDir, '..');
      writeFileSync(
        join(home, 'chats', id, 'wake.json'),
        JSON.stringify({
          chatId: id,
          message: 'check in',
          fireAt: 1_700_000_000_000 - 13 * 60_000,
          createdAt: 0,
        }),
      );
    });
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]?.prompt).toBe('running');
    expect(seen[0]?.durableTurn).toMatchObject({
      chatId,
      localId: 'L1',
      attach: { consumed: { offset: 42, envelopes: 2 } },
    });
    expect(seen[0]?.durableTurn?.config).toBe(cfg);
    expect(seen.length).toBe(2);
    expect(seen[1]?.prompt).toContain('check in');
  });

  it('cuts a turn off when its runner is gone, and clears the directory', async () => {
    const { seen, dir } = await interruptedChat('lost');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.prompt).toBe(interruptedTurnResend(INTERRUPTED_TURN_REMINDER, 'running'));
    expect(seen[0]?.durableTurn?.attach).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
  });

  it('ends a turn directory that belongs to no owed turn', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-dres-'));
    const cfg: DurableTurnConfig = {
      turnsDir: join(home, 'turns'),
      runner: { command: 'unused', args: [] },
    };
    const dir = leaveTurn(cfg, 'ghost-chat', 'L9', 'exited');
    const backend: SdkBackend = { async *run() {} };
    host(home, backend, cfg).daemon.hydrate();
    await tick(30);
    expect(existsSync(dir)).toBe(false);
  });

  it('does not start a turn under a runner when none is configured', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-dres-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-dresf-')));
    const seen: SdkRunOptions[] = [];
    const backend: SdkBackend = {
      async *run(opts) {
        seen.push(opts);
        yield { type: 'result', sessionId: 's' };
      },
    };
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: backend,
      oauthAccessToken: 'fake-token',
      emit: () => undefined,
      logger: silent,
      now: () => 1,
      generateChatId: () => 'c',
    });
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'hi', localId: 'L' });
    await tick(30);
    expect(seen[0]?.durableTurn).toBeUndefined();
  });
});

describe('a corrupt durable turn file', () => {
  const capture = () => {
    const lines: Array<Record<string, unknown>> = [];
    const logger = pino(
      { level: 'error' },
      { write: (l: string) => void lines.push(JSON.parse(l) as Record<string, unknown>) },
    );
    return { lines, logger };
  };

  it('does not stop the healthy resume or the retiring of the other leftovers', async () => {
    const { lines, logger } = capture();
    const dead = { pid: 2 ** 22 + 12345, claudePid: null };
    let bad = '';
    let good = '';
    const { seen } = await interruptedChat(
      'live',
      (cfg) => {
        // Sorts before and after: the bad one must not stop the later one.
        bad = leaveTurn(cfg, 'a-orphan', 'X', 'lost');
        writeFileSync(join(bad, 'runner.json'), '{"pid": 12');
        good = leaveTurn(cfg, 'z-orphan', 'Y', 'lost');
        writeFileSync(join(good, 'runner.json'), JSON.stringify(dead));
      },
      logger,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.durableTurn?.attach).toBeDefined();
    expect(existsSync(good)).toBe(false);
    expect(lines.some((l) => l.chatId === 'a-orphan' && String(l.dir).includes('a-orphan'))).toBe(
      true,
    );
  });

  it("treats that chat's turn as cut off, logging chatId and path", async () => {
    const { lines, logger } = capture();
    // 'lost': retiring a 'live' fixture would SIGTERM this test process.
    const { seen, chatId } = await interruptedChat(
      'lost',
      (cfg, id) => writeFileSync(join(cfg.turnsDir, id, 'turn.json'), '{trunc'),
      logger,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.prompt).toBe(interruptedTurnResend(INTERRUPTED_TURN_REMINDER, 'running'));
    expect(seen[0]?.durableTurn?.attach).toBeUndefined();
    expect(lines.some((l) => l.chatId === chatId && String(l.dir).includes(chatId))).toBe(true);
  });
});
