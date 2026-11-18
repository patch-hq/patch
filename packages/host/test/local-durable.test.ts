// Local-model turns outlive the host (spec/02 § Host restarts): a real turn
// runner, the real local agent process, a fake OpenAI-compatible endpoint on
// localhost, and a second backend run standing in for the host that comes up
// after a restart. No paid API is called.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CodexHistory } from '../src/codexHistory.js';
import {
  detachDurableTurns,
  hasDurableTurn,
  inspectTurn,
  resetDurableTurnsForTest,
  type DurableTurnConfig,
} from '../src/durableTurn.js';
import { LocalBackend, LocalModels } from '../src/localModels.js';
import type { SdkEnvelope } from '../src/sdkBackend.js';

const here = dirname(fileURLToPath(import.meta.url));
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const delta = (d: unknown) => ({ choices: [{ delta: d }] });

let server: Server;
let root: string;
let url: string;
let replies: unknown[][];
let requests: number;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'patch-local-durable-'));
  replies = [];
  requests = 0;
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests += 1;
      const chunks = replies.shift() ?? [delta({ content: 'unexpected' })];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterEach(() => {
  resetDurableTurnsForTest();
  server.close();
  rmSync(root, { recursive: true, force: true });
});

function setup() {
  const cwd = join(root, 'cwd');
  mkdirSync(cwd);
  const config: DurableTurnConfig = {
    turnsDir: join(root, 'turns'),
    runner: {
      command: process.execPath,
      args: ['--import', tsx, resolve(here, '../src/bin/turn-runner.ts')],
    },
  };
  const models = new LocalModels();
  models.setBaseUrl(url);
  const history = new CodexHistory(join(root, 'history'), 'local');
  const backend = new LocalBackend(models, history, join(root, 'sessions'), undefined, {
    command: process.execPath,
    args: ['--import', tsx, resolve(here, '../src/bin/local-agent.ts')],
  });
  const run = (
    attach: { consumed: any } | undefined,
    approve: () => Promise<{ approve: boolean }>,
    abortController = new AbortController(),
  ) =>
    backend.run({
      prompt: 'make the file',
      cwd,
      chatId: 'c1',
      model: 'local/qwen3:8b',
      permissionMode: 'default',
      oauthAccessToken: '',
      abortController,
      durableTurn: { config, chatId: 'c1', localId: 'L1', log, ...(attach ? { attach } : {}) },
      onPermissionRequest: approve,
    } as any);
  return { config, cwd, run, history };
}

describe('a durable local-model turn', () => {
  it('keeps running through a host restart and is picked up, without repeats, by the next host', async () => {
    const { config, cwd, run } = setup();
    replies = [
      [
        delta({ content: 'Writing it.' }),
        delta({
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              function: {
                name: 'Bash',
                arguments: JSON.stringify({ command: 'echo made >> out.txt' }),
              },
            },
          ],
        }),
      ],
      [delta({ content: 'Done.' })],
    ];
    const first: SdkEnvelope[] = [];
    let asked = 0;
    const gen = run(undefined, async () => {
      asked += 1;
      return new Promise(() => undefined); // the host goes away before the user answers
    })[Symbol.asyncIterator]();
    const pump = (async () => {
      for (;;) {
        const n = await gen.next();
        if (n.done) return;
        first.push(n.value);
      }
    })();
    for (let i = 0; i < 600 && asked === 0; i++) await sleep(25);
    expect(asked).toBe(1);
    expect(first.filter((e) => e.type === 'assistant').map((e: any) => e.content)).toEqual([
      'Writing it.',
    ]);
    const sessionId = first.find((e) => e.type === 'system')?.sessionId;
    expect(sessionId).toMatch(/^local-/);
    expect(inspectTurn(config, 'c1')?.state).toBe('live');

    // The host restarts: it lets go of the turn without ending it.
    expect(detachDurableTurns()).toBe(1);
    void pump;
    await sleep(100);
    const mid = inspectTurn(config, 'c1');
    expect(mid?.state).toBe('live');
    expect(mid?.consumed).not.toBeNull();

    resetDurableTurnsForTest();
    const second: SdkEnvelope[] = [];
    let askedAgain = 0;
    for await (const e of run({ consumed: mid!.consumed }, async () => {
      askedAgain += 1;
      return { approve: true };
    }))
      second.push(e);
    // The unanswered approval was asked again; what the first host showed is not repeated.
    expect(askedAgain).toBe(1);
    expect(second[0]).toEqual({ type: 'system', sessionId });
    expect(second.filter((e) => e.type === 'assistant').map((e: any) => e.content)).toEqual([
      'Done.',
    ]);
    expect(second.some((e) => e.type === 'tool_result')).toBe(true);
    expect(second.at(-1)?.type).toBe('result');
    // The same agent carried on: the model was asked twice in all, and the tool ran once.
    expect(requests).toBe(2);
    expect(readFileSync(join(cwd, 'out.txt'), 'utf8')).toBe('made\n');
    // The session the agent saved holds the whole turn, ready for the next one.
    const saved = JSON.parse(readFileSync(join(root, 'sessions', `${sessionId}.json`), 'utf8'));
    expect(saved.map((m: any) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    await sleep(300);
    expect(existsSync(join(config.turnsDir, 'c1'))).toBe(false);
    expect(hasDurableTurn('c1')).toBe(false);
  }, 30000);

  it('runs a plain turn in its own process and cleans up after it', async () => {
    const { config, run, history } = setup();
    replies = [[delta({ content: 'Hi' }), delta({ content: ' there' })]];
    const events: SdkEnvelope[] = [];
    for await (const e of run(undefined, async () => ({ approve: true }))) events.push(e);
    expect(events.map((e) => e.type)).toEqual([
      'system',
      'assistant_delta',
      'assistant_delta',
      'assistant',
      'result',
    ]);
    const sessionId = events[0]!.sessionId!;
    expect(history.entries(sessionId).length).toBeGreaterThan(0);
    await sleep(300);
    expect(existsSync(join(config.turnsDir, 'c1'))).toBe(false);
  }, 30000);

  it('a stop ends the turn and retires its runner', async () => {
    const { config, cwd, run } = setup();
    replies = [
      [
        delta({
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              function: {
                name: 'Bash',
                arguments: JSON.stringify({ command: 'sleep 30; echo late > late.txt' }),
              },
            },
          ],
        }),
      ],
    ];
    const abortController = new AbortController();
    const events: SdkEnvelope[] = [];
    let error: unknown;
    try {
      for await (const e of run(undefined, async () => ({ approve: true }), abortController)) {
        events.push(e);
        if (e.type === 'tool_use') setTimeout(() => abortController.abort(), 200);
      }
    } catch (err) {
      error = err;
    }
    expect(events.some((e) => e.type === 'tool_use')).toBe(true);
    expect(error).toBeInstanceOf(Error);
    await sleep(500);
    expect(existsSync(join(config.turnsDir, 'c1'))).toBe(false);
    expect(existsSync(join(cwd, 'late.txt'))).toBe(false);
  }, 30000);
});
