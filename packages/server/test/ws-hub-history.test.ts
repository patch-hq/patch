// How the hub answers a surface's history request from the server's record
// (spec/03 § Chat history, spec/04 § Branching), driven directly: the whole
// history of a chat whose host is offline, any branch's track (a side thread's
// included) laid out from the record, each open request on the track it was
// raised on, and the branch graph alongside. The host is never asked.

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { decode, type WireEvent } from '@patch/wire';
import { WsHub, type WsHubDeps } from '../src/ws-hub.js';
import { Registry } from '../src/registry.js';
import { PresenceTracker } from '../src/presence.js';
import { ChatRegistry } from '../src/chat-registry.js';
import { ChatLogStore } from '../src/chat-log-store.js';
import { InProcessHostLink } from '../src/host-link.js';

const silentLogger = pino({ level: 'silent' });

const say = (seq: number, branchId?: string): WireEvent =>
  ({
    type: 'chat.message',
    chatId: 'c1',
    role: 'assistant',
    content: `m${seq}`,
    seq,
    ...(branchId !== undefined ? { branchId } : {}),
  }) as WireEvent;

const branches = [
  { branchId: 'main', parentBranchId: null, forkFromSeq: null, label: 'main', createdAt: 1 },
  {
    branchId: 'side',
    parentBranchId: 'main',
    forkFromSeq: 1,
    label: 'side 1',
    createdAt: 2,
    sideThread: true as const,
  },
];

function setup(over: Partial<WsHubDeps> = {}, graph = true) {
  const registry = Registry.load(mkdtempSync(join(tmpdir(), 'patch-history-')));
  registry.bootstrapAccount();
  const chats = new ChatRegistry();
  chats.observe({ type: 'chat.spawned', chatId: 'c1', hostId: 'd1', folder: '/w' } as WireEvent);
  if (graph) {
    chats.observe({
      type: 'chat.branches',
      chatId: 'c1',
      activeBranchId: 'main',
      branches,
    } as WireEvent);
  }
  const link = new InProcessHostLink();
  const store = new ChatLogStore({ logger: silentLogger });
  const hub = new WsHub({
    logger: silentLogger,
    registry,
    presence: new PresenceTracker(),
    hostLink: link,
    chatRegistry: chats,
    idGenerator: () => 'id',
    chatLogStore: store,
    ...over,
  });
  const sent: WireEvent[] = [];
  const conn = { socket: { send: (data: string) => sent.push(decode(data)) } };
  const ask = (a: { branchId?: string; after?: number; before?: number; limit?: number } = {}) =>
    (hub as unknown as { sendHistory: (c: unknown, a: unknown) => void }).sendHistory(conn, {
      requestId: 'r1',
      chatId: 'c1',
      ...a,
    });
  const history = (): Extract<WireEvent, { type: 'chat.history' }> =>
    sent.find((e) => e.type === 'chat.history') as Extract<WireEvent, { type: 'chat.history' }>;
  return { hub, link, store, sent, ask, history };
}

const seqs = (events: unknown[]): number[] => events.map((e) => (e as { seq: number }).seq);

describe("answering history from the server's record", () => {
  it('says nothing when the hub keeps no record', () => {
    const { ask, sent } = setup({ chatLogStore: undefined });
    ask();
    expect(sent).toEqual([]);
  });

  it("answers with the chat's whole history from the record, never asking the host", () => {
    const { store, ask, history, link } = setup();
    for (const seq of [0, 1, 2]) store.commit(say(seq, 'main'));
    ask();
    expect(link.sent).toEqual([]);
    expect(seqs(history().entries)).toEqual([0, 1, 2]);
    expect(history().more).toBe(false);
    expect(history().through).toBe(2);
  });

  it("keeps a side thread's entries off the main track, and serves its own track when asked", () => {
    const { store, ask, history, sent } = setup();
    for (const seq of [0, 1, 2]) store.commit(say(seq, 'main'));
    store.commit(say(3, 'side'));
    store.commit(say(4, 'main'));
    ask();
    expect(seqs(history().entries)).toEqual([0, 1, 2, 4]);
    sent.length = 0;
    ask({ branchId: 'side' });
    expect(history().branchId).toBe('side');
    expect(seqs(history().entries)).toEqual([0, 1, 3]);
    // Entries never carry their branch out to a surface.
    expect(history().entries[2]).not.toHaveProperty('branchId');
  });

  it('sends the branch graph with the answer', () => {
    const { store, ask, sent } = setup();
    store.commit(say(0, 'main'));
    ask();
    const graph = sent.find((e) => e.type === 'chat.branches');
    expect(graph).toMatchObject({ chatId: 'c1', activeBranchId: 'main' });
  });

  it('sends no graph for a chat that has only ever had one track', () => {
    const { store, ask, sent } = setup({}, false);
    store.commit(say(0));
    ask();
    expect(sent.some((e) => e.type === 'chat.branches')).toBe(false);
  });

  it('sends each open question with the track it was raised on', () => {
    const { store, ask, history, sent } = setup();
    store.commit(say(0, 'main'));
    const question = (requestId: string, branchId?: string): WireEvent =>
      ({
        type: 'chat.permission_request',
        chatId: 'c1',
        requestId,
        request: { tool: 'AskUserQuestion', args: { questions: [] } },
        seq: 1,
        ...(branchId !== undefined ? { branchId } : {}),
      }) as WireEvent;
    store.notePermission(question('main-q'), 'main');
    store.notePermission(question('side-q', 'side'), 'main');
    ask();
    expect(history().pending.map((p) => (p as { requestId: string }).requestId)).toEqual([
      'main-q',
    ]);
    sent.length = 0;
    ask({ branchId: 'side' });
    expect(history().pending.map((p) => (p as { requestId: string }).requestId)).toEqual([
      'side-q',
    ]);
  });
});
