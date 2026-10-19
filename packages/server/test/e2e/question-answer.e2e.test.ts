// End-to-end: the agent asks a question in chat and the user answers it.
//
// REAL server + REAL host over a REAL WebSocket (harness.ts); only the SDK is
// mocked. The mock's `[[ask-user-question]]` trigger blocks the turn on the
// permission gate exactly like the real `AskUserQuestion` tool, so a card that
// is never answered, or an answer that never reaches the agent, hangs the turn
// and FAILS here (spec/02 § Questions are not approvals).

import { describe, it, expect, afterEach } from 'vitest';
import type { WireEvent } from '@patch/wire';
import { startHarness, until, record, type E2EHarness } from './harness.js';

const QUESTION = 'Which date library should we use?';

let h: E2EHarness | undefined;
afterEach(async () => {
  if (h) await h.close();
  h = undefined;
});

async function spawn(harness: E2EHarness, jwt: string): Promise<string> {
  const res = await harness.built.app.inject({
    method: 'POST',
    url: '/api/chats',
    headers: { authorization: `Bearer ${jwt}` },
    payload: { hostId: harness.hostId, folder: harness.folder },
  });
  expect(res.statusCode).toBe(202);
  return (res.json() as { chatId: string }).chatId;
}

type Req = { type: 'chat.permission_request'; requestId: string; chatId: string };

async function ask(prompt = '[[ask-user-question]]') {
  h = await startHarness();
  const jwt = await h.mintSurface('srf-q');
  const client = await h.connectSurface('srf-q-b');
  const events = record(client, [
    'chat.permission_request',
    'chat.permission_response',
    'chat.tool_result',
    'chat.state',
    'chat.error',
  ]);
  const chatId = await spawn(h, jwt);
  client.send({ type: 'chat.focus_change', chatId });
  client.sendInput({ chatId, message: prompt, localId: 'L1' });
  await until(
    () => events.some((e) => e.type === 'chat.permission_request'),
    5000,
    'question card (permission_request) reached the surface',
  );
  const req = events.find((e) => e.type === 'chat.permission_request') as unknown as Req;
  return { client, events, chatId, req };
}

const result = (events: WireEvent[]): string | undefined => {
  const e = events.find((x) => x.type === 'chat.tool_result' && x.tool === 'AskUserQuestion') as
    | { result: unknown }
    | undefined;
  return e === undefined ? undefined : String(e.result);
};

describe('e2e: answering a question in chat', () => {
  it('the card carries the questions and options to the surface', async () => {
    const { client, events, req } = await ask();
    const full = events.find((e) => e.type === 'chat.permission_request') as unknown as {
      request: { tool: string; args: { questions: Array<{ question: string }> } };
    };
    expect(full.request.tool).toBe('AskUserQuestion');
    expect(full.request.args.questions[0]?.question).toBe(QUESTION);
    expect(req.requestId).toBeTruthy();
    await client.close();
  });

  it('an answer sent from the surface reaches the agent and settles the card', async () => {
    const { client, events, chatId, req } = await ask();
    client.send({
      type: 'chat.permission_response',
      chatId,
      requestId: req.requestId,
      approve: true,
      decision: 'approve_with_edits',
      editedNewString: JSON.stringify({ [QUESTION]: 'Luxon' }),
    } as WireEvent);
    await until(() => result(events) !== undefined, 5000, 'agent received the answer');
    expect(result(events)).toContain(`${QUESTION}: Luxon`);
    await until(
      () => events.some((e) => e.type === 'chat.permission_response'),
      5000,
      'resolution echoed so every surface drops the card',
    );
    expect(events.some((e) => e.type === 'chat.error')).toBe(false);
    await client.close();
  });

  it('a free-text Other answer arrives verbatim', async () => {
    const { client, events, chatId, req } = await ask();
    client.send({
      type: 'chat.permission_response',
      chatId,
      requestId: req.requestId,
      approve: true,
      decision: 'approve_with_edits',
      editedNewString: JSON.stringify({ [QUESTION]: 'Temporal, with a polyfill' }),
    } as WireEvent);
    await until(() => result(events) !== undefined, 5000, 'agent received the answer');
    expect(result(events)).toContain('Temporal, with a polyfill');
    await client.close();
  });

  it('cancelling denies the question and tells the agent, with no error', async () => {
    const { client, events, chatId, req } = await ask();
    client.send({
      type: 'chat.permission_response',
      chatId,
      requestId: req.requestId,
      approve: false,
      decision: 'deny',
    } as WireEvent);
    await until(() => result(events) !== undefined, 5000, 'agent told of the cancel');
    expect(result(events)).not.toContain('User has answered');
    await client.close();
  });

  it('an unreadable answer is refused loudly, never approved empty', async () => {
    const { client, events, chatId, req } = await ask();
    client.send({
      type: 'chat.permission_response',
      chatId,
      requestId: req.requestId,
      approve: true,
      decision: 'approve_with_edits',
      editedNewString: 'not json',
    } as WireEvent);
    await until(
      () => events.some((e) => e.type === 'chat.error'),
      5000,
      'chat.error for an unusable answer',
    );
    expect(result(events) ?? '').not.toContain('User has answered');
    await client.close();
  });

  it('typing a message over the card cancels it instead of wedging the queue', async () => {
    const { client, events, chatId } = await ask();
    client.sendInput({ chatId, message: 'actually, neither', localId: 'L2' });
    await until(() => result(events) !== undefined, 5000, 'question superseded by the message');
    expect(result(events)).not.toContain('User has answered');
    await client.close();
  });

  it('a stale answer (card already settled) is harmless', async () => {
    const { client, events, chatId, req } = await ask();
    const answer = {
      type: 'chat.permission_response',
      chatId,
      requestId: req.requestId,
      approve: true,
      decision: 'approve_with_edits',
      editedNewString: JSON.stringify({ [QUESTION]: 'date-fns' }),
    } as WireEvent;
    client.send(answer);
    await until(() => result(events) !== undefined, 5000, 'first answer landed');
    client.send(answer);
    await new Promise((r) => setTimeout(r, 300));
    expect(
      events.filter((e) => e.type === 'chat.tool_result' && e.tool === 'AskUserQuestion'),
    ).toHaveLength(1);
    await client.close();
  });
});
