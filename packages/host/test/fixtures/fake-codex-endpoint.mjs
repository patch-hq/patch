#!/usr/bin/env node
// A stand-in for `codex app-server --stdio` that reports, as its reply, what
// it was started with: the thread parameters (model, modelProvider, config)
// and the endpoint key in its environment. Lets a test check, at the protocol
// boundary, what Patch hands Codex for a chat on a model endpoint.
import { createInterface } from 'node:readline';

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let thread;
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return out({ id: m.id, result: {} });
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    thread = { method: m.method, params: m.params };
    const id = m.params.threadId ?? 'th-endpoint';
    return out({ id: m.id, result: { thread: { id, path: `/fake/${id}` } } });
  }
  if (m.method === 'turn/start') {
    out({ id: m.id, result: { turn: { id: 't1' } } });
    const text = JSON.stringify({
      thread,
      key: process.env.PATCH_MODEL_ENDPOINT_KEY ?? null,
      codexHome: process.env.CODEX_HOME,
      args: process.argv.slice(2),
    });
    out({
      method: 'item/completed',
      params: {
        threadId: thread.params.threadId ?? 'th-endpoint',
        turnId: 't1',
        item: { type: 'agentMessage', id: 'i1', text },
      },
    });
    out({
      method: 'turn/completed',
      params: {
        threadId: thread.params.threadId ?? 'th-endpoint',
        turnId: 't1',
        turn: { id: 't1', status: 'completed', items: [] },
      },
    });
  }
});
