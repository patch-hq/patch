// "Stuff gets lost" — the task list must survive everything that happens to a
// chat: the agent rewriting or clearing its TodoWrite list, malformed agent
// input, a stalled item, attachments queued with an item, and a host restart.
// Each test reads the list back from the meta file on disk through a FRESH
// meta store (what a restarted host sees), not from in-memory chat state.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { TodoItem, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { chatStateFromMeta } from '../src/chatState.js';
import type { SdkBackend } from '../src/sdkBackend.js';

const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Env = { type: string; [k: string]: unknown };

const todoWriteArgs = (args: unknown): Env => ({
  type: 'tool_use',
  tool: { name: 'TodoWrite', args, callId: `tw-${Math.random().toString(36).slice(2, 8)}` },
});

const todoWrite = (items: Array<[string, TodoItem['status']]>): Env =>
  todoWriteArgs({
    todos: items.map(([content, status]) => ({ content, status, activeForm: content })),
  });

/** Backend whose turn N emits the Nth scripted envelope list. */
function sequencedBackend(turns: Env[][]) {
  let n = 0;
  const backend: SdkBackend = {
    async *run(): AsyncIterable<Env> {
      for (const e of turns[n++] ?? []) yield e;
      yield { type: 'result', sessionId: 'sess' };
      yield { type: 'assistant', content: 'ok', sessionId: 'sess' };
    },
  };
  return backend;
}

function setup(backend: SdkBackend, opts: { autoAdvanceTodos?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-tododur-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-tododur-folder-')));
  mkdirSync(folder, { recursive: true });
  const events: WireEvent[] = [];
  const warnings: string[] = [];
  const logger = pino({ level: 'silent' });
  logger.warn = ((...a: unknown[]) => void warnings.push(String(a[a.length - 1]))) as never;
  let id = 0;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: backend,
    oauthAccessToken: 'fake-token',
    emit: (e) => events.push(e),
    logger,
    now: () => Date.now(),
    generateChatId: () => `chat-${++id}`,
    autoAdvanceTodos: opts.autoAdvanceTodos ?? true,
  });
  /** What a restarted host would load: a fresh store over the same home. */
  const reloaded = (chatId: string) => createMetaStore(home).read(chatId);
  return { daemon, folder, events, warnings, reloaded };
}

describe('task list durability', () => {
  it("persists the agent's TodoWrite list so a restart still sees it", async () => {
    const { daemon, folder, reloaded } = setup(
      sequencedBackend([
        [
          todoWrite([
            ['a', 'completed'],
            ['b', 'pending'],
          ]),
        ],
        [],
      ]),
    );
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go', localId: 'u-go' });
    await tick();
    // 'b' was fired and came back unfinished → promoted, and the promotion persisted
    const onDisk = [
      { text: 'a', status: 'completed' },
      { text: 'b', status: 'in_progress' },
    ];
    expect(reloaded(chatId)?.todos).toEqual(onDisk);
    expect(chatStateFromMeta(reloaded(chatId)!).todos).toEqual(onDisk);
  });

  it('persists each rewrite: the latest agent list wins on disk', async () => {
    const { daemon, folder, reloaded } = setup(
      sequencedBackend([
        [todoWrite([['a', 'pending']])],
        [
          todoWrite([
            ['a', 'completed'],
            ['b', 'completed'],
          ]),
        ],
      ]),
      { autoAdvanceTodos: true },
    );
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go', localId: 'u-go' });
    await tick(80);
    expect(reloaded(chatId)?.todos).toEqual([
      { text: 'a', status: 'completed' },
      { text: 'b', status: 'completed' },
    ]);
  });

  it('persists a list the agent clears', async () => {
    const { daemon, folder, reloaded } = setup(
      sequencedBackend([[todoWrite([['a', 'completed']])], [todoWriteArgs({ todos: [] })]]),
    );
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'one', localId: 'u-one' });
    await tick();
    await daemon.sendInput({ chatId, message: 'two', localId: 'u-two' });
    await tick();
    expect(reloaded(chatId)?.todos).toEqual([]);
  });

  it('leaves the stored list untouched, and warns, when TodoWrite args are malformed', async () => {
    const bad: unknown[] = [
      { todos: 'nope' },
      { todos: [{ content: 'x', status: 'bogus' }] },
      { todos: [null] },
      null,
      'str',
    ];
    for (const args of bad) {
      const { daemon, folder, reloaded, warnings } = setup(
        sequencedBackend([[todoWrite([['keep', 'completed']])], [todoWriteArgs(args)]]),
      );
      const chatId = await daemon.spawnChat({ folder });
      await daemon.sendInput({ chatId, message: 'one', localId: 'u-one' });
      await tick();
      await daemon.sendInput({ chatId, message: 'two', localId: 'u-two' });
      await tick();
      expect(reloaded(chatId)?.todos, JSON.stringify(args)).toEqual([
        { text: 'keep', status: 'completed' },
      ]);
      expect(warnings.some((w) => w.includes('unrecognised'))).toBe(true);
    }
  });

  it('keeps a queued item’s attachments on disk when the agent rewrites its list', async () => {
    const att = [
      { id: 'att-1', name: 'spec.pdf', mimeType: 'application/pdf', kind: 'file' as const },
    ];
    const { daemon, folder, reloaded } = setup(
      sequencedBackend([[todoWrite([['read spec', 'completed']])]]),
    );
    const chatId = await daemon.spawnChat({ folder });
    daemon.setTodos(chatId, [{ text: 'read spec', status: 'pending', attachments: att }]);
    expect(reloaded(chatId)?.todos?.[0]?.attachments).toEqual(att);
    await daemon.sendInput({ chatId, message: 'go', localId: 'u-go' });
    await tick();
    const after = reloaded(chatId)?.todos;
    expect(after?.[0]).toMatchObject({ text: 'read spec', status: 'completed' });
    expect(after?.[0]?.attachments).toEqual(att);
  });

  it('persists a stalled item as in_progress rather than losing that a turn was spent', async () => {
    const { daemon, folder, reloaded } = setup(
      sequencedBackend([[todoWrite([['hard thing', 'pending']])], []]),
    );
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go', localId: 'u-go' });
    await tick(120);
    expect(reloaded(chatId)?.todos).toEqual([{ text: 'hard thing', status: 'in_progress' }]);
  });

  it('does not touch a chat’s stored list when auto-advance is off', async () => {
    const { daemon, folder, reloaded } = setup(
      sequencedBackend([[todoWrite([['a', 'pending']])]]),
      { autoAdvanceTodos: false },
    );
    const chatId = await daemon.spawnChat({ folder });
    daemon.setTodos(chatId, [{ text: 'mine', status: 'pending' }]);
    await daemon.sendInput({ chatId, message: 'go', localId: 'u-go' });
    await tick();
    expect(reloaded(chatId)?.todos).toEqual([{ text: 'mine', status: 'pending' }]);
  });

  it('emits chat.state with the list on every change so surfaces never lag the disk', async () => {
    const { daemon, folder, events, reloaded } = setup(
      sequencedBackend([[todoWrite([['a', 'completed']])]]),
    );
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'go', localId: 'u-go' });
    await tick();
    const last = [...events]
      .reverse()
      .find((e) => e.type === 'chat.state' && Array.isArray((e as { todos?: unknown }).todos));
    expect((last as { todos?: unknown }).todos).toEqual(reloaded(chatId)?.todos);
  });
});
