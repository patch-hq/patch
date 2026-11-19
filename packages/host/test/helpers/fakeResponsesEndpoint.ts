// A stand-in for an OpenAI-compatible model server (Ollama, LM Studio, vLLM,
// a router): `GET /models` lists its models and `POST /responses` streams a
// Responses API reply, which is what Codex calls on a custom model provider.
// Each request is kept so a test can see what Codex sent, including the key.
//
// A reply is scripted per request: plain text, or a function call (which
// makes Codex run a tool and call back with its output).

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type ScriptedReply =
  | { text: string }
  | { call: { name: string; arguments: Record<string, unknown> } };

export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: Record<string, any> | undefined;
}

export interface FakeResponsesEndpoint {
  /** `http://127.0.0.1:<port>/v1` */
  baseUrl: string;
  requests: RecordedRequest[];
  /** Requests to `/responses`, in order. */
  turns(): RecordedRequest[];
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * Start the endpoint. `reply` decides each `/responses` answer from the
 * request body (`input` is the conversation so far); `models` is what
 * `/models` lists.
 */
export async function startFakeResponsesEndpoint(opts: {
  models?: string[];
  reply: (body: Record<string, any>, n: number) => ScriptedReply;
}): Promise<FakeResponsesEndpoint> {
  const requests: RecordedRequest[] = [];
  let n = 0;
  const server: Server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const path = (req.url ?? '').replace(/^\/v1/, '');
      const body = raw ? (JSON.parse(raw) as Record<string, any>) : undefined;
      requests.push({
        method: req.method ?? '',
        path,
        authorization: req.headers['authorization'],
        body,
      });
      if (req.method === 'GET' && path === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data: (opts.models ?? []).map((id) => ({ id, object: 'model' })),
          }),
        );
        return;
      }
      if (req.method === 'POST' && path === '/responses') {
        const reply = opts.reply(body ?? {}, n++);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const id = `resp_${n}`;
        let seq = 0;
        const send = (type: string, data: Record<string, unknown>) =>
          res.write(
            `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`,
          );
        const base = { id, object: 'response', model: body?.['model'], created_at: 0 };
        send('response.created', { response: { ...base, status: 'in_progress', output: [] } });
        let item: Record<string, unknown>;
        if ('text' in reply) {
          const itemId = `msg_${n}`;
          send('response.output_item.added', {
            output_index: 0,
            item: {
              id: itemId,
              type: 'message',
              role: 'assistant',
              status: 'in_progress',
              content: [],
            },
          });
          send('response.output_text.delta', {
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            delta: reply.text,
          });
          item = {
            id: itemId,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: reply.text, annotations: [] }],
          };
        } else {
          item = {
            id: `fc_${n}`,
            type: 'function_call',
            status: 'completed',
            call_id: `call_${n}`,
            name: reply.call.name,
            arguments: JSON.stringify(reply.call.arguments),
          };
          send('response.output_item.added', { output_index: 0, item });
        }
        send('response.output_item.done', { output_index: 0, item });
        send('response.completed', {
          response: {
            ...base,
            status: 'completed',
            output: [item],
            usage: {
              input_tokens: 10,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens: 5,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: 15,
            },
          },
        });
        res.end();
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `no route ${req.method} ${path}` } }));
    })().catch((err: unknown) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    turns: () => requests.filter((r) => r.path === '/responses'),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
