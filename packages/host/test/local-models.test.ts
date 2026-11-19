// Local models (docs/providers.md): the endpoint config, the model list the
// endpoint offers, and a real turn through the engine against a fake
// Ollama-style server on localhost. No paid API is ever called.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { WireEvent } from '@patch/wire';
import { CodexHistory } from '../src/codexHistory.js';
import { LocalBackend, LocalModels, isLocalModel } from '../src/localModels.js';
import type { ModelCatalog } from '../src/modelCatalog.js';
import { handleModelsRequest } from '../src/index.js';
import type { SdkEnvelope, SdkRunOptions } from '../src/sdkBackend.js';

let server: Server;
let dir: string;
let url: string;
let requests: Array<{ path: string; auth: string | undefined; body: any }>;
let replies: string[];
let modelList: unknown;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'local-models-'));
  requests = [];
  replies = [];
  modelList = { data: [{ id: 'qwen3:8b' }, { id: 'llama3.2' }] };
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({
        path: req.url ?? '',
        auth: req.headers.authorization,
        body: raw ? JSON.parse(raw) : undefined,
      });
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(modelList));
        return;
      }
      const reply = replies.shift() ?? 'ok';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterEach(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const seqIndex = { resolve: (keys: string[]) => keys.map((_, i) => i) } as any;
const opts = (o: Partial<SdkRunOptions> = {}): SdkRunOptions =>
  ({
    prompt: 'hello',
    cwd: dir,
    chatId: 'chat-1',
    model: 'local/qwen3:8b',
    abortController: new AbortController(),
    oauthAccessToken: '',
    permissionMode: 'bypassPermissions',
    ...o,
  }) as SdkRunOptions;
async function collect(it: AsyncIterable<SdkEnvelope>): Promise<SdkEnvelope[]> {
  const out: SdkEnvelope[] = [];
  for await (const e of it) out.push(e);
  return out;
}
function setup() {
  const local = new LocalModels();
  local.setBaseUrl(url);
  const history = new CodexHistory(join(dir, 'history'), 'local');
  return { local, history, backend: new LocalBackend(local, history, join(dir, 'sessions')) };
}

describe('LocalModels', () => {
  it('recognises local/ models only', () => {
    expect(isLocalModel('local/qwen3:8b')).toBe(true);
    expect(isLocalModel('openai/gpt-5')).toBe(false);
    expect(isLocalModel(undefined)).toBe(false);
  });

  it('says so when no endpoint is set, for the list and for a turn', async () => {
    const local = new LocalModels();
    expect(local.configured).toBe(false);
    await expect(local.models()).rejects.toThrow(/No local model endpoint is set/);
    expect(() => local.resolveEndpoint('local/x')).toThrow(/No local model endpoint is set/);
  });

  it('treats an empty setting as cleared', () => {
    const local = new LocalModels();
    local.setBaseUrl('http://h:1/v1/');
    expect(local.configured).toBe(true);
    local.setBaseUrl('');
    expect(local.configured).toBe(false);
  });

  it('resolves the endpoint without a trailing slash and strips the prefix, keeping colons', () => {
    const local = new LocalModels();
    local.setBaseUrl('http://h:1/v1//');
    expect(local.resolveEndpoint('local/qwen3:8b')).toEqual({
      baseUrl: 'http://h:1/v1',
      model: 'qwen3:8b',
    });
  });

  it('lists what the endpoint serves as local/ models', async () => {
    const { local } = setup();
    expect(await local.models()).toEqual([
      { id: 'local/qwen3:8b', label: 'qwen3:8b' },
      { id: 'local/llama3.2', label: 'llama3.2' },
    ]);
  });

  it('refuses a malformed list and an unreachable endpoint by name', async () => {
    const { local } = setup();
    modelList = { nope: true };
    await expect(local.models()).rejects.toThrow(/did not return a model list/);
    server.close();
    await expect(local.models()).rejects.toThrow(/Cannot reach the local model endpoint/);
  });
});

describe('LocalBackend', () => {
  it('runs a turn on the named model, keyless, and records it for the history reader', async () => {
    replies = ['Hi there'];
    const { backend, history } = setup();
    const out = await collect(backend.run(opts()));
    const sessionId = out.find((e) => e.type === 'result')!.sessionId!;
    expect(sessionId.startsWith('local-')).toBe(true);
    const chat = requests.find((r) => r.path === '/v1/chat/completions')!;
    expect(chat.body.model).toBe('qwen3:8b');
    expect(chat.auth).toBeUndefined();
    expect(history.hasSession({ folder: dir, sessionId })).toBe(true);
    const events = history.read({
      chatId: 'chat-1',
      folder: dir,
      sessionId,
      fromSeq: -1,
      seqIndex,
    });
    expect(events.map((e) => [e.type, (e as any).role, (e as any).content])).toEqual([
      ['chat.message', 'user', 'hello'],
      ['chat.message', 'assistant', 'Hi there'],
    ]);
  });

  it('resumes its own session with the earlier messages', async () => {
    replies = ['one', 'two'];
    const { backend, history } = setup();
    const first = await collect(backend.run(opts()));
    const sessionId = first.find((e) => e.type === 'result')!.sessionId!;
    await collect(backend.run(opts({ prompt: 'again', resumeSessionId: sessionId })));
    const second = requests.filter((r) => r.path === '/v1/chat/completions')[1]!.body.messages;
    expect(second.map((m: any) => m.content)).toEqual(['hello', 'one', 'again']);
    const events = history.read({
      chatId: 'chat-1',
      folder: dir,
      sessionId,
      fromSeq: -1,
      seqIndex,
    });
    expect(events).toHaveLength(4);
  });

  it('fails loudly with no endpoint, and refuses to branch', async () => {
    const history = new CodexHistory(join(dir, 'history'), 'local');
    const backend = new LocalBackend(new LocalModels(), history, join(dir, 'sessions'));
    await expect(collect(backend.run(opts()))).rejects.toThrow(/No local model endpoint is set/);
    const { backend: ready } = setup();
    await expect(
      collect(ready.run(opts({ fork: { resumeAtUuid: 'x' } } as Partial<SdkRunOptions>))),
    ).rejects.toThrow(/not supported on local models/);
  });

  it('will not resume another provider’s session', async () => {
    const { backend } = setup();
    await expect(collect(backend.run(opts({ resumeSessionId: 'codex-abc' })))).rejects.toThrow(
      /cannot be resumed/,
    );
  });
});

describe('history store prefixes', () => {
  it('a local store refuses a Codex session id and vice versa', () => {
    const local = new CodexHistory(join(dir, 'h1'), 'local');
    const codex = new CodexHistory(join(dir, 'h2'));
    expect(() => local.begin('codex-1')).toThrow(/Invalid local session id/);
    expect(() => codex.begin('local-1')).toThrow(/Invalid codex session id/);
  });
});

describe('patch.models.request with local models', () => {
  const logger = { warn() {}, info() {}, error() {}, debug() {} } as any;
  const codex = { models: async () => [{ id: 'openai/gpt-5', label: 'GPT-5' }] } as any;
  const ask = async (local: LocalModels) => {
    const sent: WireEvent[] = [];
    // The catalogue's own credential is stubbed out: only the local entries matter here.
    const stubCatalog = {
      get: async () => ({ models: [{ id: 'claude-opus-5', label: 'Opus 5' }] }),
    } as unknown as ModelCatalog;
    await handleModelsRequest(
      { type: 'patch.models.request', hostId: 'd1', requestId: 'm1' },
      stubCatalog,
      (e) => sent.push(e),
      logger,
      'd1',
      codex,
      local,
    );
    return sent[0] as Extract<WireEvent, { type: 'patch.models.response' }>;
  };

  it('adds the endpoint’s models against the local backend', async () => {
    const { local } = setup();
    const res = await ask(local);
    expect(res.models.filter((m) => m.backend === 'local').map((m) => m.id)).toEqual([
      'local/qwen3:8b',
      'local/llama3.2',
    ]);
    expect(res.errors).toEqual([]);
  });

  it('reports an unreachable endpoint against the local backend, keeping the other models', async () => {
    const { local } = setup();
    server.close();
    const res = await ask(local);
    expect(res.models.map((m) => m.id)).toEqual(['claude-opus-5', 'openai/gpt-5']);
    expect(res.errors).toMatchObject([{ backend: 'local', code: 'upstream' }]);
  });

  it('says nothing about local when no endpoint is set', async () => {
    const res = await ask(new LocalModels());
    expect(res.errors).toEqual([]);
    expect(res.models.some((m) => m.backend === 'local')).toBe(false);
  });
});
