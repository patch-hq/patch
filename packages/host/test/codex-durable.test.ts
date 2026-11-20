// Codex turns outlive the host (spec/02 § Host restarts): a real turn runner,
// a fake `codex app-server`, and a second backend run standing in for the host
// that comes up after a restart.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CodexBackend } from '../src/codexBackend.js';
import { CodexClient } from '../src/codexClient.js';
import { CodexSessions } from '../src/codexSessions.js';
import type { DurableCodexProcess } from '../src/codexDurable.js';
import {
  detachDurableTurns,
  hasDurableTurn,
  inspectTurn,
  resetDurableTurnsForTest,
  type DurableTurnConfig,
} from '../src/durableTurn.js';
import type { SdkEnvelope } from '../src/sdkBackend.js';

const here = dirname(fileURLToPath(import.meta.url));
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(() => resetDurableTurnsForTest());

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'patch-codex-durable-'));
  const cwd = join(root, 'cwd');
  mkdirSync(cwd);
  const config: DurableTurnConfig = {
    turnsDir: join(root, 'turns'),
    runner: {
      command: process.execPath,
      args: ['--import', tsx, resolve(here, '../src/bin/turn-runner.ts')],
    },
  };
  const history = new CodexSessions(root);
  const clients: CodexClient[] = [];
  const accounts: any = {
    resolveChosen: async () => ({ accountId: 'a' }),
    turnClient: async (_id: string, durable?: DurableCodexProcess) => {
      const client = new CodexClient({
        home: join(root, 'codex-home'),
        executable: resolve(here, 'fixtures/fake-codex.mjs'),
        credentialStore: 'existing',
        ...(durable ? { durable } : {}),
      });
      clients.push(client);
      await client.start();
      return client;
    },
    releaseTurnClient: async (c: CodexClient) => c.close(),
    markExhausted: () => undefined,
    refresh: async () => undefined,
  };
  const backend = new CodexBackend(accounts, history);
  const run = (
    attach: { consumed: any } | undefined,
    approve: () => Promise<{ approve: boolean }>,
  ) =>
    backend.run({
      prompt: 'go',
      cwd,
      chatId: 'c1',
      model: 'gpt',
      permissionMode: 'default',
      oauthAccessToken: '',
      abortController: new AbortController(),
      durableTurn: { config, chatId: 'c1', localId: 'L1', log, ...(attach ? { attach } : {}) },
      onPermissionRequest: approve,
    } as any);
  return { config, run, clients };
}

describe('a durable Codex turn', () => {
  it('keeps running through a host restart and is picked up, without repeats, by the next host', async () => {
    const { config, run } = setup();
    const first: SdkEnvelope[] = [];
    let asked = false;
    const gen = run(undefined, async () => {
      asked = true;
      return new Promise(() => undefined); // the host goes away before the user answers
    })[Symbol.asyncIterator]();
    const pump = (async () => {
      for (;;) {
        const n = await gen.next();
        if (n.done) return;
        first.push(n.value);
      }
    })();
    for (let i = 0; i < 400 && !asked; i++) await sleep(25);
    expect(asked).toBe(true);
    expect(first.filter((e) => e.type === 'assistant').map((e: any) => e.content)).toEqual([
      'first',
    ]);
    const before = inspectTurn(config, 'c1');
    expect(before?.state).toBe('live');

    // The host restarts: it lets go of the turn without ending it.
    expect(detachDurableTurns()).toBe(1);
    void pump;
    await sleep(100);
    const mid = inspectTurn(config, 'c1');
    expect(mid?.state).toBe('live');
    expect(mid?.consumed).not.toBeNull();

    resetDurableTurnsForTest();
    const second: SdkEnvelope[] = [];
    for await (const e of run({ consumed: mid!.consumed }, async () => ({ approve: true })))
      second.push(e);
    const said = second.filter((e) => e.type === 'assistant').map((e: any) => e.content);
    // 'first' was handled by the previous host; the unanswered approval was asked again;
    // 'second:accept' can only exist if the same app-server carried on.
    expect(said).toEqual(['second:accept']);
    expect(second.at(-1)?.type).toBe('result');
    await sleep(300);
    expect(existsSync(join(config.turnsDir, 'c1'))).toBe(false);
    expect(hasDurableTurn('c1')).toBe(false);
  }, 30000);

  it('removes the turn directory when a turn finishes normally', async () => {
    const { config, run } = setup();
    const events: SdkEnvelope[] = [];
    for await (const e of run(undefined, async () => ({ approve: true }))) events.push(e);
    expect(events.at(-1)?.type).toBe('result');
    await sleep(300);
    expect(existsSync(join(config.turnsDir, 'c1'))).toBe(false);
  }, 30000);
});
