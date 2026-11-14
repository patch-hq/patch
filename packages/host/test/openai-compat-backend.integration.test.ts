import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { OpenAICompatBackend } from '../src/openaiCompatBackend.js';
import type { SdkEnvelope, SdkRunOptions } from '../src/sdkBackend.js';

type Script = Array<{ status?: number; chunks: unknown[] }>;

let server: Server;
let dir: string;
let requests: Array<{ auth: string | undefined; body: any }>;
let script: Script;

const delta = (d: unknown) => ({ choices: [{ delta: d }] });
const text = (t: string) => delta({ content: t });
const call = (id: string, name: string, args: unknown) =>
  delta({
    tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }],
  });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'oai-'));
  requests = [];
  script = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      const step = script.shift();
      if (!step) {
        res.writeHead(500).end('script exhausted');
        return;
      }
      res.writeHead(step.status ?? 200, { 'content-type': 'text/event-stream' });
      if (step.status && step.status !== 200) return void res.end('nope');
      for (const c of step.chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
});
afterEach(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

function backend(apiKey?: string) {
  const port = (server.address() as AddressInfo).port;
  return new OpenAICompatBackend({
    sessionDir: join(dir, 'sessions'),
    resolveEndpoint: () => ({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey, model: 'm1' }),
  });
}
const opts = (o: Partial<SdkRunOptions> = {}): SdkRunOptions =>
  ({
    prompt: 'hi',
    cwd: dir,
    abortController: new AbortController(),
    oauthAccessToken: '',
    permissionMode: 'bypassPermissions',
    ...o,
  }) as SdkRunOptions;
async function collect(it: AsyncIterable<SdkEnvelope>) {
  const out: SdkEnvelope[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('OpenAICompatBackend', () => {
  it('streams a plain answer and sends the bearer key', async () => {
    script = [{ chunks: [text('Hel'), text('lo')] }];
    const out = await collect(backend('k-123').run(opts()));
    expect(out.map((e) => e.type)).toEqual([
      'system',
      'assistant_delta',
      'assistant_delta',
      'assistant',
      'result',
    ]);
    expect(out.find((e) => e.type === 'assistant')?.content).toBe('Hello');
    expect(requests[0]!.auth).toBe('Bearer k-123');
    expect(requests[0]!.body.model).toBe('m1');
  });

  it('sends no auth header for a keyless local server', async () => {
    script = [{ chunks: [text('x')] }];
    await collect(backend().run(opts()));
    expect(requests[0]!.auth).toBeUndefined();
  });

  it('runs a tool call, feeds the result back and finishes', async () => {
    writeFileSync(join(dir, 'a.txt'), 'file body');
    script = [{ chunks: [call('c1', 'Read', { path: 'a.txt' })] }, { chunks: [text('done')] }];
    const out = await collect(backend().run(opts()));
    expect(out.find((e) => e.type === 'tool_result')?.toolResult?.result).toBe('file body');
    const second = requests[1]!.body.messages;
    expect(second.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: 'file body' });
  });

  it('runs Bash and Write', async () => {
    script = [
      { chunks: [call('c1', 'Write', { path: 'sub/w.txt', content: 'abc' })] },
      { chunks: [call('c2', 'Bash', { command: 'cat sub/w.txt' })] },
      { chunks: [text('ok')] },
    ];
    const out = await collect(backend().run(opts()));
    expect(readFileSync(join(dir, 'sub/w.txt'), 'utf8')).toBe('abc');
    expect(out.filter((e) => e.type === 'tool_result')[1]?.toolResult?.result).toBe('abc');
  });

  it('plan mode offers only Read and refuses others', async () => {
    script = [{ chunks: [call('c1', 'Bash', { command: 'echo hi' })] }, { chunks: [text('ok')] }];
    const out = await collect(backend().run(opts({ permissionMode: 'plan' })));
    expect(requests[0]!.body.tools.map((t: any) => t.function.name)).toEqual(['Read']);
    expect(out.find((e) => e.type === 'tool_result')?.toolResult?.isError).toBe(true);
  });

  it('default mode asks before a tool and honours a denial', async () => {
    script = [{ chunks: [call('c1', 'Bash', { command: 'echo hi' })] }, { chunks: [text('ok')] }];
    const asked: string[] = [];
    const out = await collect(
      backend().run(
        opts({
          permissionMode: 'default',
          onPermissionRequest: async (r) => {
            asked.push(r.tool);
            return { approve: false };
          },
        }),
      ),
    );
    expect(asked).toEqual(['Bash']);
    expect(out.find((e) => e.type === 'tool_result')?.toolResult?.isError).toBe(true);
  });

  it('resumes a saved session with its history', async () => {
    script = [{ chunks: [text('one')] }, { chunks: [text('two')] }];
    const b = backend();
    const first = await collect(b.run(opts({ prompt: 'first' })));
    const id = first.find((e) => e.type === 'result')!.sessionId!;
    expect(id.startsWith('oai-')).toBe(true);
    await collect(b.run(opts({ prompt: 'second', resumeSessionId: id })));
    expect(requests[1]!.body.messages.map((m: any) => m.content)).toEqual([
      'first',
      'one',
      'second',
    ]);
  });

  it('rejects a Claude session id', async () => {
    await expect(collect(backend().run(opts({ resumeSessionId: 'abc' })))).rejects.toThrow(
      /cannot be resumed/,
    );
  });

  it('rejects auto permissions', async () => {
    await expect(collect(backend().run(opts({ permissionMode: 'auto' })))).rejects.toThrow(
      /auto permissions/,
    );
  });

  it('surfaces an HTTP failure, flagging 429 as a rate limit', async () => {
    script = [{ status: 429, chunks: [] }];
    await expect(collect(backend().run(opts()))).rejects.toMatchObject({
      limit: { kind: 'rate_limit' },
    });
  });

  it('fails loudly on malformed tool arguments', async () => {
    script = [
      {
        chunks: [
          delta({
            tool_calls: [{ index: 0, id: 'c', function: { name: 'Read', arguments: '{bad' } }],
          }),
        ],
      },
    ];
    await expect(collect(backend().run(opts()))).rejects.toThrow(/malformed arguments/);
  });

  it('stops a runaway tool loop', async () => {
    script = Array.from({ length: 5 }, () => ({
      chunks: [call('c', 'Bash', { command: 'true' })],
    }));
    const port = (server.address() as AddressInfo).port;
    const b = new OpenAICompatBackend({
      sessionDir: join(dir, 's'),
      maxSteps: 2,
      resolveEndpoint: () => ({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm' }),
    });
    await expect(collect(b.run(opts()))).rejects.toThrow(/Stopped after 2 steps/);
  });
});
