// Local models and routers run through Codex as a model endpoint (spec/02 §
// Provider adapters), not on an agent loop of Patch's own.
//
// Three layers: what Patch hands `codex app-server` for an endpoint chat,
// checked at the protocol boundary with a fake app-server; the same chat
// carried through a host restart by the turn runner; and a real pinned Codex
// running real turns (a tool call, then a resumed second turn) against a fake
// OpenAI-compatible endpoint. No paid API is called anywhere.

import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CodexAccounts } from '../src/codexAccounts.js';
import { CodexBackend } from '../src/codexBackend.js';
import { CodexSessions } from '../src/codexSessions.js';
import { ModelEndpointRegistry } from '../src/modelEndpoints.js';
import {
  detachDurableTurns,
  inspectTurn,
  resetDurableTurnsForTest,
  type DurableTurnConfig,
} from '../src/durableTurn.js';
import type { SdkEnvelope, SdkRunOptions } from '../src/sdkBackend.js';
import { startFakeResponsesEndpoint } from './helpers/fakeResponsesEndpoint.js';

const here = dirname(fileURLToPath(import.meta.url));
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(() => resetDurableTurnsForTest());

function setup(executable: string, baseUrl = 'http://127.0.0.1:11434/v1') {
  const root = mkdtempSync(join(tmpdir(), 'patch-endpoint-'));
  const cwd = join(root, 'cwd');
  mkdirSync(cwd);
  // No Codex login at all: an endpoint chat needs none.
  const accounts = new CodexAccounts({
    root: join(root, 'openai'),
    hostId: 'test',
    executable,
    onChange: () => {},
  });
  const endpoints = new ModelEndpointRegistry();
  endpoints.apply(
    [
      { id: 'ollama', label: 'Ollama', api: 'openai', baseUrl },
      { id: 'router', label: 'Router', api: 'anthropic', baseUrl: 'http://127.0.0.1:4000' },
    ],
    { ollama: 'sk-endpoint-key-1234' },
  );
  const history = new CodexSessions(join(root, 'history'));
  const backend = new CodexBackend(accounts, history, endpoints);
  const collect = async (
    over: Partial<SdkRunOptions> & { model: string; prompt: string },
  ): Promise<SdkEnvelope[]> => {
    const events: SdkEnvelope[] = [];
    for await (const e of backend.run({
      cwd,
      chatId: 'c1',
      permissionMode: 'bypassPermissions',
      oauthAccessToken: '',
      abortController: new AbortController(),
      ...over,
    } as SdkRunOptions))
      events.push(e);
    return events;
  };
  return { root, cwd, accounts, backend, history, collect };
}

const reported = (events: SdkEnvelope[]) =>
  JSON.parse(events.find((e) => e.type === 'assistant')!.content as string);

describe('a chat on an OpenAI-compatible endpoint, at the Codex protocol boundary', () => {
  const fake = resolve(here, 'fixtures/fake-codex-endpoint.mjs');
  chmodSync(fake, 0o755);

  it('starts a Codex thread on the endpoint as a custom model provider, on no Codex login', async () => {
    const { collect, accounts, root } = setup(fake);
    const events = await collect({ model: 'openai/endpoint/ollama/qwen3:8b', prompt: 'hi' });
    const seen = reported(events);
    expect(seen.thread.method).toBe('thread/start');
    expect(seen.thread.params).toMatchObject({
      model: 'qwen3:8b',
      modelProvider: 'patch-ollama',
      config: {
        model_providers: {
          'patch-ollama': {
            name: 'Ollama',
            base_url: 'http://127.0.0.1:11434/v1',
            wire_api: 'responses',
            env_key: 'PATCH_MODEL_ENDPOINT_KEY',
          },
        },
      },
    });
    // The key reaches Codex only through the environment variable it names.
    expect(seen.key).toBe('sk-endpoint-key-1234');
    expect(JSON.stringify(seen.thread.params)).not.toContain('sk-endpoint-key-1234');
    expect(seen.codexHome).toBe(join(root, 'openai', 'endpoints'));
    expect(seen.args).toContain('cli_auth_credentials_store="ephemeral"');
    expect(events.find((e) => e.sessionId)?.sessionId).toBe('codex-th-endpoint');
    await accounts.close();
  });

  it('resumes the thread on the same provider next turn', async () => {
    const { collect, accounts } = setup(fake);
    const first = await collect({ model: 'openai/endpoint/ollama/qwen3:8b', prompt: 'one' });
    const session = first.find((e) => e.sessionId)!.sessionId!;
    const second = await collect({
      model: 'openai/endpoint/ollama/qwen3:8b',
      prompt: 'two',
      resumeSessionId: session,
    });
    const seen = reported(second);
    expect(seen.thread.method).toBe('thread/resume');
    expect(seen.thread.params).toMatchObject({
      threadId: 'th-endpoint',
      modelProvider: 'patch-ollama',
      model: 'qwen3:8b',
    });
    await accounts.close();
  });

  it('refuses an endpoint that is not set up, naming it, before any process starts', async () => {
    const { collect, accounts } = setup('/nonexistent/codex');
    await expect(collect({ model: 'openai/endpoint/gone/m', prompt: 'hi' })).rejects.toThrow(
      /endpoint "gone" is not set up/,
    );
    await expect(collect({ model: 'openai/endpoint/router/m', prompt: 'hi' })).rejects.toThrow(
      /not set up/,
    );
    await accounts.close();
  });

  it('an ordinary Codex model still needs a ChatGPT login', async () => {
    const { collect, accounts } = setup(fake);
    await expect(collect({ model: 'openai/gpt-5', prompt: 'hi' })).rejects.toThrow(/sign-in/i);
    await accounts.close();
  });
});

describe('a durable endpoint turn', () => {
  it('runs under the turn runner and is picked up by the next host after a restart', async () => {
    const {
      collect: _unused,
      backend,
      cwd,
      root,
      accounts,
    } = setup(resolve(here, 'fixtures/fake-codex.mjs'));
    void _unused;
    const config: DurableTurnConfig = {
      turnsDir: join(root, 'turns'),
      runner: {
        command: process.execPath,
        args: ['--import', tsx, resolve(here, '../src/bin/turn-runner.ts')],
      },
    };
    const run = (
      attach: { consumed: unknown } | undefined,
      approve: () => Promise<{ approve: boolean }>,
    ) =>
      backend.run({
        prompt: 'go',
        cwd,
        chatId: 'c1',
        model: 'openai/endpoint/ollama/qwen3:8b',
        permissionMode: 'default',
        oauthAccessToken: '',
        abortController: new AbortController(),
        durableTurn: { config, chatId: 'c1', localId: 'L1', log, ...(attach ? { attach } : {}) },
        onPermissionRequest: approve,
      } as unknown as SdkRunOptions);

    const first: SdkEnvelope[] = [];
    let asked = false;
    const gen = run(undefined, async () => {
      asked = true;
      return new Promise(() => undefined); // the host goes away before the user answers
    })[Symbol.asyncIterator]();
    void (async () => {
      for (;;) {
        const n = await gen.next();
        if (n.done) return;
        first.push(n.value);
      }
    })();
    for (let i = 0; i < 400 && !asked; i++) await sleep(25);
    expect(asked).toBe(true);
    expect(inspectTurn(config, 'c1')?.state).toBe('live');

    expect(detachDurableTurns()).toBe(1);
    await sleep(100);
    const mid = inspectTurn(config, 'c1');
    expect(mid?.state).toBe('live');

    resetDurableTurnsForTest();
    const second: SdkEnvelope[] = [];
    for await (const e of run({ consumed: mid!.consumed }, async () => ({ approve: true })))
      second.push(e);
    expect(second.filter((e) => e.type === 'assistant').map((e) => e.content)).toEqual([
      'second:accept',
    ]);
    expect(second.at(-1)?.type).toBe('result');
    await accounts.close();
  }, 30000);
});

// The pinned Codex this host would run: the managed runtime, or one named for the test.
const managedCodex = join(homedir(), '.patch/backends/codex/node_modules/.bin/codex');
const realCodex =
  process.env['PATCH_CODEX_EXECUTABLE'] ?? (existsSync(managedCodex) ? managedCodex : undefined);

describe('a real Codex on a fake OpenAI-compatible endpoint', () => {
  it.skipIf(realCodex === undefined)(
    'runs a tool the model asks for, then resumes with the conversation intact',
    async () => {
      const endpoint = await startFakeResponsesEndpoint({
        models: ['qwen3:8b'],
        reply: (body, n) => {
          if (n === 0)
            return {
              call: {
                name: 'exec_command',
                arguments: { cmd: 'echo PATCH_ENDPOINT_OK > out.txt' },
              },
            };
          if (n === 1) return { text: 'FILE_WRITTEN' };
          // The second turn: the endpoint sees the first turn's call and answer.
          const seen = JSON.stringify(body['input']);
          return { text: seen.includes('PATCH_ENDPOINT_OK') ? 'REMEMBERED' : 'FORGOT' };
        },
      });
      const { collect, cwd, accounts, history } = setup(realCodex!, endpoint.baseUrl);
      try {
        const first = await collect({
          model: 'openai/endpoint/ollama/qwen3:8b',
          prompt: 'write the file',
        });
        expect(readFileSync(join(cwd, 'out.txt'), 'utf8').trim()).toBe('PATCH_ENDPOINT_OK');
        expect(first.some((e) => e.type === 'tool_use' && e.tool?.name === 'Bash')).toBe(true);
        expect(first.filter((e) => e.type === 'assistant').map((e) => e.content)).toEqual([
          'FILE_WRITTEN',
        ]);
        const session = first.find((e) => e.sessionId)?.sessionId;
        expect(session).toMatch(/^codex-/);
        expect(history.hasSession({ folder: cwd, sessionId: session! })).toBe(true);
        const turns = endpoint.turns();
        expect(turns.map((t) => t.body?.['model'])).toEqual(['qwen3:8b', 'qwen3:8b']);
        expect(turns.every((t) => t.authorization === 'Bearer sk-endpoint-key-1234')).toBe(true);

        const second = await collect({
          model: 'openai/endpoint/ollama/qwen3:8b',
          prompt: 'what did you write?',
          resumeSessionId: session!,
        });
        expect(second.filter((e) => e.type === 'assistant').map((e) => e.content)).toEqual([
          'REMEMBERED',
        ]);
      } finally {
        await accounts.close();
        await endpoint.close();
      }
    },
    120000,
  );
});

describe('the endpoint catalogue', () => {
  it('lists what the endpoint serves under Codex, labelled with the endpoint', async () => {
    const endpoint = await startFakeResponsesEndpoint({
      models: ['qwen3:8b'],
      reply: () => ({ text: '' }),
    });
    try {
      const registry = new ModelEndpointRegistry();
      registry.apply(
        [{ id: 'ollama', label: 'Ollama', api: 'openai', baseUrl: `${endpoint.baseUrl}/` }],
        {
          ollama: 'sk-endpoint-key-1234',
        },
      );
      expect(await registry.models(registry.list()[0]!)).toEqual([
        { id: 'openai/endpoint/ollama/qwen3:8b', label: 'qwen3:8b · Ollama (ChatGPT)' },
      ]);
      expect(endpoint.requests[0]?.authorization).toBe('Bearer sk-endpoint-key-1234');
    } finally {
      await endpoint.close();
    }
  });

  it('offers only the models named in settings when there are some, without asking the endpoint', async () => {
    const registry = new ModelEndpointRegistry(() => {
      throw new Error('must not be asked');
    });
    registry.apply([
      {
        id: 'or',
        label: 'OpenRouter',
        api: 'anthropic',
        baseUrl: 'https://x/api',
        models: ['a/b'],
      },
    ]);
    expect(await registry.models(registry.list()[0]!)).toEqual([
      { id: 'claude/endpoint/or/a/b', label: 'a/b · OpenRouter (Claude Code)' },
    ]);
    expect(registry.claudeLaunch('claude/endpoint/or/a/b')).toEqual({
      model: 'a/b',
      baseUrl: 'https://x/api',
    });
  });

  it('reports an endpoint it cannot reach, naming it', async () => {
    const registry = new ModelEndpointRegistry();
    registry.apply([
      { id: 'down', label: 'Down box', api: 'openai', baseUrl: 'http://127.0.0.1:9/v1' },
    ]);
    await expect(registry.models(registry.list()[0]!)).rejects.toThrow(/Cannot reach Down box/);
  });
});
