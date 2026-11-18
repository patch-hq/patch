#!/usr/bin/env node
// A fake Agent Client Protocol agent, built on the official ACP library's own
// agent side, so the host's adapter is tested against the protocol as the
// library speaks it rather than as the adapter assumes it.
//
// Behaviour by prompt text:
//   hello  — thinks, says "Hello there", asks permission for a tool call, runs
//            it (or not), posts a plan, says "done:<outcome>:<model>:<mode>"
//   slow   — says "working" and waits until cancelled
//   crash  — exits mid-turn
//   limit  — refuses with a quota error
//   echo   — says back what this session has heard so far (memory check)
//
// Environment:
//   FAKE_ACP_STATE      folder sessions are kept in (for session/load)
//   FAKE_ACP_LOG        file every request is appended to, as JSON lines
//   FAKE_ACP_NEED_KEY   when set, session/new refuses unless FAKE_ACP_KEY is set
//   FAKE_ACP_NO_LOAD    when set, the agent does not advertise loadSession

import { agent, ndJsonStream, RequestError } from '@agentclientprotocol/sdk';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';

const STATE = process.env.FAKE_ACP_STATE ?? join(process.cwd(), '.fake-acp');
mkdirSync(STATE, { recursive: true });
const log = (entry) => {
  if (process.env.FAKE_ACP_LOG)
    appendFileSync(process.env.FAKE_ACP_LOG, JSON.stringify(entry) + '\n');
};
const sessionFile = (id) => join(STATE, `${id}.json`);
const loadState = (id) =>
  existsSync(sessionFile(id)) ? JSON.parse(readFileSync(sessionFile(id), 'utf8')) : undefined;
const saveState = (id, s) => writeFileSync(sessionFile(id), JSON.stringify(s));

const MODELS = {
  availableModels: [
    { modelId: 'fake-pro', name: 'Fake Pro' },
    { modelId: 'fake-flash', name: 'Fake Flash' },
  ],
};
const MODES = [
  { id: 'default', name: 'Default' },
  { id: 'autoEdit', name: 'Auto Edit' },
  { id: 'yolo', name: 'YOLO' },
];
const cancelled = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sessionResponse(id, s) {
  return {
    sessionId: id,
    modes: { availableModes: MODES, currentModeId: s.mode },
    models: { ...MODELS, currentModelId: s.model },
  };
}

const app = agent({ name: 'fake-acp' })
  .onRequest('initialize', ({ params }) => {
    log({ method: 'initialize', params });
    return {
      protocolVersion: 1,
      agentInfo: { name: 'fake-acp', title: 'Fake ACP', version: '9.9.9' },
      agentCapabilities: {
        loadSession: !process.env.FAKE_ACP_NO_LOAD,
        promptCapabilities: { image: false },
      },
      authMethods: [],
    };
  })
  .onRequest('session/new', ({ params }) => {
    log({ method: 'session/new', params });
    if (process.env.FAKE_ACP_NEED_KEY && !process.env.FAKE_ACP_KEY)
      throw new RequestError(
        -32000,
        'Authentication required: Gemini API key is missing or not configured.',
      );
    const id = randomUUID();
    const s = { model: 'fake-pro', mode: 'default', heard: [] };
    saveState(id, s);
    return sessionResponse(id, s);
  })
  .onRequest('session/load', async ({ params, client }) => {
    log({ method: 'session/load', params });
    const s = loadState(params.sessionId);
    if (!s) throw new RequestError(-32002, `Session not found: ${params.sessionId}`);
    // ACP: a load replays the conversation before it answers.
    for (const text of s.heard) {
      await client.notify('session/update', {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } },
      });
      await client.notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `replayed:${text}` },
        },
      });
    }
    return {
      modes: { availableModes: MODES, currentModeId: s.mode },
      models: { ...MODELS, currentModelId: s.model },
    };
  })
  .onRequest('session/set_mode', ({ params }) => {
    log({ method: 'session/set_mode', params });
    const s = loadState(params.sessionId);
    s.mode = params.modeId;
    saveState(params.sessionId, s);
    return {};
  })
  // `session/set_model` is not in the library's stable method table.
  .onRequest('*', ({ method, params }) => {
    log({ method, params });
    if (method === 'session/set_model') {
      const s = loadState(params.sessionId);
      s.model = params.modelId;
      saveState(params.sessionId, s);
      return {};
    }
    throw RequestError.methodNotFound(method);
  })
  .onNotification('session/cancel', ({ params }) => {
    log({ method: 'session/cancel', params });
    cancelled.add(params.sessionId);
  })
  .onRequest('session/prompt', async ({ params, client }) => {
    log({ method: 'session/prompt', params });
    const id = params.sessionId;
    const s = loadState(id);
    const text = params.prompt.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const say = (update) => client.notify('session/update', { sessionId: id, update });
    const chunk = (t) =>
      say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });
    const remember = () => {
      s.heard.push(text);
      saveState(id, s);
    };
    if (text === 'crash') {
      await chunk('about to crash');
      process.exit(3);
    }
    if (text === 'limit')
      throw new RequestError(-32603, '429 RESOURCE_EXHAUSTED: quota exceeded for this key');
    if (text === 'slow') {
      await chunk('working');
      for (let i = 0; i < 400 && !cancelled.has(id); i++) await sleep(25);
      return { stopReason: cancelled.has(id) ? 'cancelled' : 'end_turn' };
    }
    if (text === 'echo') {
      await chunk(`heard:${s.heard.join('|')}`);
      remember();
      return { stopReason: 'end_turn' };
    }
    // hello
    await say({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'pondering' },
    });
    await chunk('Hello ');
    await chunk('there');
    await say({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      title: 'List files',
      kind: 'execute',
      status: 'pending',
      rawInput: { command: 'ls' },
    });
    const answer = await client.request('session/request_permission', {
      sessionId: id,
      toolCall: { toolCallId: 'tool-1', title: 'List files', kind: 'execute' },
      options: [
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const outcome = answer.outcome.outcome === 'selected' ? answer.outcome.optionId : 'cancelled';
    await say({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-1',
      status: outcome === 'no' || outcome === 'cancelled' ? 'failed' : 'completed',
      content: [
        {
          type: 'content',
          content: { type: 'text', text: outcome === 'no' ? 'denied' : 'file.txt' },
        },
      ],
    });
    await say({
      sessionUpdate: 'plan',
      entries: [
        { content: 'look around', priority: 'high', status: 'completed' },
        { content: 'report back', priority: 'medium', status: 'in_progress' },
      ],
    });
    await chunk(`done:${outcome}:${s.model}:${loadState(id).mode}`);
    remember();
    return { stopReason: 'end_turn' };
  });

const conn = app.connect(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);
await conn.closed;
