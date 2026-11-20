// End-to-end notes to the agent (spec/04 § Notes to the agent) — REAL server + REAL host over a REAL WebSocket link; only the SDK backend
// is mocked, and it writes a real transcript for replay.
//
// The path exercised:
//   POST /api/chats/:id/todos  (a surface rewrites the task list)
//     → server → real serverLink WS → real Daemon.setTodos
//   chat.input from the surface
//     → host prefixes the turn with a todo-edit note
//       → the agent receives it as plain text (the mock echoes its prompt)
//       → the surface receives it as its own chat.note entry ahead of the user
//         chat.message, which carries only what was typed
//   a history read from a fresh surface
//     → the same chat.note rebuilt from the persisted transcript.

import { describe, it, expect, afterEach } from 'vitest';
import type { WireEvent } from '@patch/wire';
import { startHarness, expectReply, record, until, type E2EHarness } from './harness.js';

let h: E2EHarness | undefined;
afterEach(async () => {
  if (h) await h.close();
  h = undefined;
});

type UserMessage = Extract<WireEvent, { type: 'chat.message' }>;
const userMessages = (events: WireEvent[], chatId: string): UserMessage[] =>
  events.filter(
    (e): e is UserMessage => e.type === 'chat.message' && e.chatId === chatId && e.role === 'user',
  );

type Note = Extract<WireEvent, { type: 'chat.note' }>;
const notes = (events: WireEvent[], chatId: string): Note[] =>
  events.filter((e): e is Note => e.type === 'chat.note' && e.chatId === chatId);

describe('e2e notes: a note to the agent reaches the surface as its own entry', () => {
  it('carries a todo-edit note as a chat.note live and on replay, never in the message content', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('srf-sc1');
    const client = await h.connectSurface('srf-sc1b');
    const states = record(client, ['chat.state']);

    const spawn = await h.built.app.inject({
      method: 'POST',
      url: '/api/chats',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { hostId: h.hostId, folder: h.folder },
    });
    expect(spawn.statusCode).toBe(202);
    const chatId = (spawn.json() as { chatId: string }).chatId;
    await until(
      () => states.some((e) => e.type === 'chat.state' && e.chatId === chatId),
      3000,
      'chat.state after spawn',
    );
    client.send({ type: 'chat.focus_change', chatId });
    const live = record(client, ['chat.message', 'chat.note']);

    const todos = await fetch(`${h.httpBase}/api/chats/${chatId}/todos`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ todos: [{ text: 'water the tomatoes', status: 'pending' }] }),
    });
    expect(todos.status).toBe(200);
    await until(
      () =>
        states.some(
          (e) =>
            e.type === 'chat.state' &&
            e.chatId === chatId &&
            e.todos?.some((t) => t.text === 'water the tomatoes') === true,
        ),
      3000,
      'the host adopted the edited list',
    );

    client.send({ type: 'chat.input', chatId, message: 'go on then', localId: 'L-sc1' });
    const reply = await expectReply(client, chatId, 'todo-edit reminder');
    // The agent really received the block (the mock echoes its whole prompt).
    expect(reply.content).toContain('[Note: Todo list updated]');
    expect(reply.content).not.toContain('system-reminder');
    expect(reply.content).toContain('water the tomatoes');

    await until(() => userMessages(live, chatId).length > 0, 3000, 'live user chat.message');
    const liveUser = userMessages(live, chatId)[0]!;
    expect(liveUser.content).toBe('go on then');
    expect(liveUser).not.toHaveProperty('systemContext');
    const liveNote = notes(live, chatId)[0]!;
    expect(liveNote.label).toBe('Todo list updated');
    expect(liveNote.text).toContain('water the tomatoes');
    expect(liveNote.seq).toBeLessThan(liveUser.seq);

    await client.close();
    const client2 = await h.connectSurface('srf-sc1c');
    const replayed = record(client2, ['chat.message', 'chat.note']);
    client2.history(chatId, { after: -1 });
    await until(
      () => userMessages(replayed, chatId).some((m) => m.content === 'go on then'),
      3000,
      'replayed user turn',
    );
    const replayedUser = userMessages(replayed, chatId).find((m) => m.content === 'go on then')!;
    const replayedNote = notes(replayed, chatId)[0]!;
    expect(replayedNote.label).toBe(liveNote.label);
    expect(replayedNote.text).toBe(liveNote.text);
    expect(replayedNote.seq).toBe(liveNote.seq);
    expect(replayedUser.seq).toBe(liveUser.seq);
    await client2.close();
  });
});
