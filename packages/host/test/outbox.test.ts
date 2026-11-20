// The host outbox (spec/02 § Host outbox): transcript events kept on disk until
// the server acknowledges them, and resent after every reconnect.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import WS, { type WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decode, encode, type WireEvent } from '@patch/wire';
import { Outbox } from '../src/outbox.js';
import { createServerLink, type ServerLink } from '../src/serverLink.js';

const silent = pino({ level: 'silent' });

const say = (seq: number, chatId = 'c1'): WireEvent =>
  ({ type: 'chat.message', chatId, role: 'assistant', content: `m${seq}`, seq }) as WireEvent;

class FakeSocket extends EventEmitter {
  readyState: number = WS.CONNECTING;
  sent: Record<string, unknown>[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  ping(): void {}
  terminate(): void {
    this.close();
  }
  close(code = 1000, reason = ''): void {
    if (this.readyState === WS.CLOSED) return;
    this.readyState = WS.CLOSED;
    this.emit('close', code, Buffer.from(reason));
  }
  open(): void {
    this.readyState = WS.OPEN;
    this.emit('open');
  }
  receive(frame: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(frame)));
  }
}

const authOk = (extra: Record<string, unknown> = {}) => ({
  type: 'auth.ok',
  accountId: 'a',
  surfaceId: 'h1',
  hosts: [],
  ...extra,
});

describe('Outbox', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-outbox-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const open = (compactAfter?: number) =>
    new Outbox({
      path: join(dir, 'outbox.jsonl'),
      logger: silent,
      ...(compactAfter !== undefined ? { compactAfter } : {}),
    });

  it('numbers events across chats and keeps them until acknowledged', () => {
    const box = open();
    expect(box.append(say(1))).toBe(0);
    expect(box.append(say(1, 'c2'))).toBe(1);
    expect(box.append(say(2))).toBe(2);
    box.ack(1);
    expect(box.pending().map((p) => p.position)).toEqual([2]);
    expect(box.acknowledged()).toBe(1);
  });

  it('survives a restart: owed events and the numbering come back', () => {
    const first = open();
    first.append(say(1));
    first.append(say(2));
    first.ack(0);
    const second = open();
    expect(second.pending().map((p) => p.position)).toEqual([1]);
    expect(second.append(say(3))).toBe(2);
  });

  it('ignores an acknowledgement it has already passed, and one past what it holds', () => {
    const box = open();
    box.append(say(1));
    box.ack(0);
    box.ack(0);
    box.ack(-1);
    expect(box.acknowledged()).toBe(0);
    box.ack(99);
    expect(box.acknowledged()).toBe(0);
    expect(box.append(say(2))).toBe(1);
  });

  it('rewrites the file to what is still owed once enough is acknowledged', () => {
    const box = open(3);
    for (let i = 0; i < 5; i++) box.append(say(i));
    box.ack(3);
    const lines = readFileSync(join(dir, 'outbox.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2); // the acknowledgement and the one still owed
    const again = open(3);
    expect(again.pending().map((p) => p.position)).toEqual([4]);
    expect(again.append(say(9))).toBe(5);
  });

  it('skips a torn last line from a crash', () => {
    const box = open();
    box.append(say(1));
    appendFileSync(join(dir, 'outbox.jsonl'), '{"p":1,"e":{"ty');
    expect(
      open()
        .pending()
        .map((p) => p.position),
    ).toEqual([0]);
  });
});

describe('server link with an outbox', () => {
  let dir: string;
  let sockets: FakeSocket[];
  let link: ServerLink;
  let outbox: Outbox;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-outbox-link-'));
    sockets = [];
    outbox = new Outbox({ path: join(dir, 'outbox.jsonl'), logger: silent });
    link = createServerLink({
      url: 'ws://x/ws',
      daemonKey: 'k',
      clientVersion: '1',
      logger: silent,
      outbox,
      backoffSchedule: [60_000],
      heartbeatIntervalMs: 60_000,
      wsFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s as unknown as WebSocket;
      },
    });
  });
  afterEach(async () => {
    await link.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const connect = (greeting = authOk({ hostOutbox: true })): FakeSocket => {
    const s = sockets[sockets.length - 1]!;
    s.open();
    s.receive(greeting);
    return s;
  };

  it('says it has an outbox in its hello', () => {
    link.start();
    sockets[0]!.open();
    expect(sockets[0]!.sent[0]).toMatchObject({ type: 'hello', outbox: true });
  });

  it('wraps transcript events, sends live ones bare, and drops what the server acknowledges', () => {
    link.start();
    const s = connect();
    s.sent.length = 0;
    link.send(say(1));
    link.send({ type: 'chat.message_delta', chatId: 'c1', messageSeq: 1, delta: 'x' } as WireEvent);
    expect(s.sent).toEqual([
      { type: 'host.outbox', position: 0, event: say(1) },
      { type: 'chat.message_delta', chatId: 'c1', messageSeq: 1, delta: 'x' },
    ]);
    expect(link.diagnostics().outboxOwed).toBe(1);
    s.receive({ type: 'host.outbox_ack', through: 0 });
    expect(link.diagnostics().outboxOwed).toBe(0);
  });

  it('keeps events while offline and resends everything unacknowledged after reconnecting', () => {
    link.start();
    const s = connect();
    link.send(say(1)); // sent, never acknowledged: the socket was half-open
    s.close(1006);
    link.send(say(2)); // offline
    link.start(); // redial now rather than waiting out the backoff
    const again = connect();
    const resent = again.sent.filter((f) => f['type'] === 'host.outbox');
    expect(resent.map((f) => f['position'])).toEqual([0, 1]);
  });

  it('a server without the outbox is sent no transcript; it is held until a server takes it', () => {
    link.start();
    const s = connect(authOk());
    s.sent.length = 0;
    link.send(say(1));
    expect(s.sent).toEqual([]);
    expect(link.diagnostics().outboxOwed).toBe(1);
    s.close(1006);
    link.start();
    const again = connect();
    expect(again.sent.filter((f) => f['type'] === 'host.outbox')).toEqual([
      { type: 'host.outbox', position: 0, event: say(1) },
    ]);
  });

  it('a transcript event sent from inside a link callback still goes through the outbox', () => {
    link.close();
    link = createServerLink({
      url: 'ws://x/ws',
      daemonKey: 'k',
      clientVersion: '1',
      logger: silent,
      outbox,
      backoffSchedule: [60_000],
      heartbeatIntervalMs: 60_000,
      onAuthed: (send) => send(say(7)),
      wsFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s as unknown as WebSocket;
      },
    });
    link.start();
    const s = connect();
    expect(s.sent.filter((f) => f['type'] !== 'hello')).toEqual([
      { type: 'host.outbox', position: 0, event: say(7) },
    ]);
    expect(outbox.pending()).toHaveLength(1);
  });

  it('keeps what was not acknowledged across a host restart, and resends it in order', async () => {
    link.start();
    const s = connect();
    link.send(say(1));
    link.send(say(2));
    link.send(say(3));
    s.receive({ type: 'host.outbox_ack', through: 0 });
    await link.close();

    // The restarted host: a new outbox and link over the same file.
    const reopened = new Outbox({ path: join(dir, 'outbox.jsonl'), logger: silent });
    expect(reopened.pending().map((p) => p.position)).toEqual([1, 2]);
    link = createServerLink({
      url: 'ws://x/ws',
      daemonKey: 'k',
      clientVersion: '1',
      logger: silent,
      outbox: reopened,
      backoffSchedule: [60_000],
      heartbeatIntervalMs: 60_000,
      wsFactory: () => {
        const sock = new FakeSocket();
        sockets.push(sock);
        return sock as unknown as WebSocket;
      },
    });
    link.start();
    const again = connect();
    expect(again.sent.filter((f) => f['type'] === 'host.outbox')).toEqual([
      { type: 'host.outbox', position: 1, event: say(2) },
      { type: 'host.outbox', position: 2, event: say(3) },
    ]);
    // New events carry on the numbering.
    link.send(say(4));
    expect(again.sent.at(-1)).toEqual({ type: 'host.outbox', position: 3, event: say(4) });
  });

  it('an event addressed to one surface is not kept: it is a replay, not new', () => {
    link.start();
    const s = connect();
    s.sent.length = 0;
    link.send({ ...say(1), forSurfaceId: 's1' } as WireEvent);
    expect(s.sent[0]!['type']).toBe('chat.message');
    expect(link.diagnostics().outboxOwed).toBe(0);
  });

  describe('the whole record: turn boundaries and provider ids', () => {
    const ref = { harness: 'claude', sessionId: 's1', id: 'u1' };
    const withRef = (seq: number): WireEvent => ({ ...say(seq), nativeRef: ref }) as WireEvent;
    const started = (seq: number): WireEvent =>
      ({
        type: 'chat.turn_started',
        chatId: 'c1',
        turnId: 't1',
        seq,
        at: 1,
      }) as WireEvent;
    const ended = (seq: number): WireEvent =>
      ({
        type: 'chat.turn_ended',
        chatId: 'c1',
        turnId: 't1',
        seq,
        at: 2,
        outcome: 'completed',
      }) as WireEvent;

    it('keeps a turn boundary in the outbox, even one before the first entry (seq -1)', () => {
      link.start();
      const s = connect(authOk({ hostOutbox: true, recordComplete: true }));
      s.sent.length = 0;
      link.send(started(-1));
      link.send(withRef(0));
      link.send(ended(0));
      expect(s.sent).toEqual([
        { type: 'host.outbox', position: 0, event: started(-1) },
        { type: 'host.outbox', position: 1, event: withRef(0) },
        { type: 'host.outbox', position: 2, event: ended(0) },
      ]);
      expect(link.diagnostics().outboxOwed).toBe(3);
    });

    it('an older server is sent neither, and the entries still go, without the provider id', () => {
      link.start();
      const s = connect(authOk({ hostOutbox: true }));
      s.sent.length = 0;
      link.send(started(-1));
      link.send(withRef(0));
      link.send(ended(0));
      expect(s.sent).toEqual([{ type: 'host.outbox', position: 1, event: say(0) }]);
      // The server's acknowledgement of the entry covers the boundaries before it.
      s.receive({ type: 'host.outbox_ack', through: 1 });
      expect(outbox.pending().map((e) => e.position)).toEqual([2]);
    });

    it('what was kept while offline goes whole to a server that keeps the record', () => {
      link.start();
      const s = connect(authOk({ hostOutbox: true }));
      s.close(1006);
      link.send(started(-1));
      link.send(withRef(0));
      link.start();
      const again = connect(authOk({ hostOutbox: true, recordComplete: true }));
      const resent = again.sent.filter((f) => f['type'] === 'host.outbox');
      expect(resent.map((f) => f['event'])).toEqual([started(-1), withRef(0)]);
    });
  });

  describe('tool-log entries: kept by a server that answers reads', () => {
    const entry = (ts: number): WireEvent =>
      ({
        type: 'patch.tool_log.entry',
        entry: { ts, tool: 'patch_peek', durationMs: 1, ok: true },
      }) as WireEvent;

    it('go through the outbox to a server with `serverReads`', () => {
      link.start();
      const s = connect(authOk({ hostOutbox: true, recordComplete: true, serverReads: true }));
      s.sent.length = 0;
      link.send(entry(1));
      expect(s.sent).toEqual([{ type: 'host.outbox', position: 0, event: entry(1) }]);
      expect(link.answersReads()).toBe(true);
    });

    it('are held for a server without it, and sent once one with it connects', () => {
      link.start();
      const s = connect(authOk({ hostOutbox: true, recordComplete: true }));
      s.sent.length = 0;
      link.send(entry(1));
      expect(s.sent).toEqual([]);
      expect(link.answersReads()).toBe(false);
      s.close(1006);
      link.start();
      const again = connect(authOk({ hostOutbox: true, recordComplete: true, serverReads: true }));
      const resent = again.sent.filter((f) => f['type'] === 'host.outbox');
      expect(resent.map((f) => f['event'])).toEqual([entry(1)]);
    });
  });

  // spec/12 § Chat status: a server that decides status itself says
  // `serverStatus`; until a host sees it, it sends chat.state exactly as before,
  // so a host that updates first still works with the server it finds.
  describe('chat.state for a server that decides status, and for one that does not', () => {
    const state = (): WireEvent =>
      ({
        type: 'chat.state',
        chatId: 'c1',
        hostId: 'h1',
        activity: 'errored',
        lastError: { code: 'sdk_error', message: 'boom', at: 1 },
        queuedTurns: 1,
        permissionMode: 'auto',
        lastUpdated: 5,
      }) as WireEvent;
    const sentStates = (s: FakeSocket): Record<string, unknown>[] =>
      s.sent.filter((f) => f['type'] === 'chat.state');

    it('a server without the flag gets the old shape: activity and lastError, no queuedTurns', () => {
      link.start();
      const s = connect(authOk({ hostOutbox: true, recordComplete: true }));
      link.send(state());
      const [frame] = sentStates(s);
      expect(frame).toMatchObject({ activity: 'errored', lastError: { code: 'sdk_error' } });
      expect(frame).not.toHaveProperty('queuedTurns');
      // An older server's strict reader takes it, `activity` required as it was.
      const decodedActivity = (
        decode(encode(frame as unknown as WireEvent)) as { activity?: string }
      ).activity;
      expect(decodedActivity).toBe('errored');
    });

    it('a server with the flag gets the facts only', () => {
      link.start();
      const s = connect(authOk({ hostOutbox: true, recordComplete: true, serverStatus: true }));
      link.send(state());
      const [frame] = sentStates(s);
      expect(frame).not.toHaveProperty('activity');
      expect(frame).not.toHaveProperty('lastError');
      expect(frame).toMatchObject({ queuedTurns: 1 });
    });

    it('a frame held while offline is shaped for the server it finally reaches', () => {
      link.start();
      const first = connect(authOk({ hostOutbox: true, serverStatus: true }));
      first.close(1006);
      link.send(state());
      link.start();
      const old = connect(authOk({ hostOutbox: true }));
      const [frame] = sentStates(old);
      expect(frame).toMatchObject({ activity: 'errored' });
      expect(frame).not.toHaveProperty('queuedTurns');
    });
  });
});
