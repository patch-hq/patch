#!/usr/bin/env node
// A stand-in for `codex app-server --stdio`: JSON-RPC lines on stdio. A turn
// says one thing, asks for approval of a command, and finishes only once the
// approval is answered. Its pid is reported in the thread path.
import { createInterface } from 'node:readline';

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const item = (id, text) => ({ type: 'agentMessage', id, text });
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return out({ id: m.id, result: {} });
  if (m.method === 'thread/start')
    return out({ id: m.id, result: { thread: { id: 'th1', path: `/fake/${process.pid}` } } });
  if (m.method === 'turn/start') {
    out({ id: m.id, result: { turn: { id: 't1' } } });
    setTimeout(() => {
      out({ method: 'item/completed', params: { threadId: 'th1', turnId: 't1', item: item('i1', 'first') } });
      out({
        id: 900,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 'th1', turnId: 't1', command: 'ls' },
      });
    }, 100);
    return;
  }
  if (m.id === 900 && m.method === undefined) {
    out({ method: 'item/completed', params: { threadId: 'th1', turnId: 't1', item: item('i2', `second:${m.result.decision}`) } });
    out({
      method: 'turn/completed',
      params: { threadId: 'th1', turnId: 't1', turn: { id: 't1', status: 'completed', items: [] } },
    });
  }
});
