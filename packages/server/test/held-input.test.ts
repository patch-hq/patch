// A person's message to a chat whose host is offline is held by the server and
// delivered when the host comes back. It has to survive a server restart.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import { decode, type WireEvent } from '@patch/wire';
import { InboundHostLink } from '../src/host-link.js';
import { HeldInputStore, HELD_INPUT_MAX_AGE_MS } from '../src/held-input-store.js';

const logger = pino({ level: 'silent' });

class FakeSocket extends EventEmitter {
  sent: WireEvent[] = [];
  send(data: string | Buffer): void {
    this.sent.push(decode(Buffer.from(data)));
  }
  close(): void {
    this.emit('close');
  }
}

const input = (localId: string): WireEvent =>
  ({
    type: 'chat.input',
    chatId: 'c1',
    message: `text ${localId}`,
    localId,
  }) as WireEvent;

describe('messages held for an offline host', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-held-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const makeLink = (now?: () => number) =>
    new InboundHostLink({
      logger,
      heldInputs: new HeldInputStore({ dataDir: dir, logger, ...(now ? { now } : {}) }),
    });

  it('delivers a message sent while the host was offline once it attaches', () => {
    const link = makeLink();
    link.sendTo('d1', 'srf-1', input('L1'));
    const socket = new FakeSocket();
    link.attach(socket as never, 'd1');
    expect(socket.sent.map((e) => (e as { localId: string }).localId)).toEqual(['L1']);
  });

  it('still delivers it after the server restarted in between', () => {
    makeLink().sendTo('d1', 'srf-1', input('L1'));
    makeLink().sendTo('d1', 'srf-1', input('L2'));

    const restarted = makeLink();
    const socket = new FakeSocket();
    restarted.attach(socket as never, 'd1');
    expect(socket.sent.map((e) => (e as { localId: string }).localId)).toEqual(['L1', 'L2']);
  });

  it('does not deliver a message twice across a restart once the host took it', () => {
    const link = makeLink();
    link.sendTo('d1', 'srf-1', input('L1'));
    link.attach(new FakeSocket() as never, 'd1');

    const restarted = makeLink();
    const socket = new FakeSocket();
    restarted.attach(socket as never, 'd1');
    expect(socket.sent).toEqual([]);
  });

  it("holds only a person's message, not every control frame", () => {
    const link = makeLink();
    link.sendTo('d1', 'srf-1', { type: 'chat.stop_request', chatId: 'c1' } as WireEvent);
    const socket = new FakeSocket();
    makeLink().attach(socket as never, 'd1');
    expect(socket.sent).toEqual([]);
  });

  it('forgetting a host drops what was held for it', () => {
    const link = makeLink();
    link.sendTo('d1', 'srf-1', input('L1'));
    link.forget('d1');
    const socket = new FakeSocket();
    makeLink().attach(socket as never, 'd1');
    expect(socket.sent).toEqual([]);
  });

  it('does not deliver a message that waited longer than the limit — the host is told instead', () => {
    let now = 1_000;
    makeLink(() => now).sendTo('d1', 'srf-1', input('L1'));
    now += HELD_INPUT_MAX_AGE_MS + 1;
    const socket = new FakeSocket();
    makeLink(() => now).attach(socket as never, 'd1');
    // Not the message: the notice that it expired, for the chat's own writer to
    // record (spec/12 § Host-offline UX).
    expect(socket.sent).toEqual([
      {
        type: 'chat.held_input_expired',
        chatId: 'c1',
        text: 'text L1',
        heldAt: 1_000,
        hostName: 'd1',
      },
    ]);
  });

  it('drops a message past the limit from memory and disk, not just from view', () => {
    // all() hid an expired message but kept it, so a host that never came
    // back left its messages in held-input.json for ever.
    let now = 1_000;
    const store = new HeldInputStore({ dataDir: dir, logger, now: () => now });
    store.add('d1', 'srf-1', input('L1'));
    now += HELD_INPUT_MAX_AGE_MS + 1;
    store.add('d2', 'srf-1', input('L2'));
    const onDisk = JSON.parse(readFileSync(join(dir, 'held-input.json'), 'utf8')) as {
      hostId: string;
      event: WireEvent;
    }[];
    // The message is gone; a small notice for d1 stands in its place until d1
    // takes it, so the expiry is never silent.
    expect(onDisk.map((h) => [h.hostId, h.event.type])).toEqual([
      ['d1', 'chat.held_input_expired'],
      ['d2', 'chat.input'],
    ]);
    const reloaded = new HeldInputStore({ dataDir: dir, logger, now: () => now });
    expect(reloaded.all().map((h) => [h.hostId, h.event.type])).toEqual([
      ['d1', 'chat.held_input_expired'],
      ['d2', 'chat.input'],
    ]);
  });

  it('starts empty and says so when the held file is damaged', () => {
    writeFileSync(join(dir, 'held-input.json'), '{not json');
    const socket = new FakeSocket();
    makeLink().attach(socket as never, 'd1');
    expect(socket.sent).toEqual([]);
  });

  it('stamps a message with the real clock when it is not given one', () => {
    const before = Date.now();
    const store = new HeldInputStore({ dataDir: dir, logger });
    store.add('d1', 'srf-1', input('L1'));
    const [held] = store.all();
    expect(held!.at).toBeGreaterThanOrEqual(before);
    expect(held!.at).toBeLessThanOrEqual(Date.now());
  });

  it('keeps messages in memory only when it has no data directory', () => {
    const store = new HeldInputStore({ logger });
    store.add('d1', 'srf-1', input('L1'));
    expect(store.all()).toHaveLength(1);
    store.clearHost('d1');
    expect(store.all()).toEqual([]);
  });

  it('clearing a host that holds nothing writes nothing', () => {
    const store = new HeldInputStore({ dataDir: dir, logger });
    store.add('d1', 'srf-1', input('L1'));
    store.clearHost('someone-else');
    expect(store.all()).toHaveLength(1);
    expect(new HeldInputStore({ dataDir: dir, logger }).all()).toHaveLength(1);
  });

  it('says so, and keeps the message in memory, when it cannot write its file', () => {
    const warned: string[] = [];
    const store = new HeldInputStore({
      dataDir: join(dir, 'not', 'a', 'directory'),
      logger: { warn: (_o, m) => warned.push(String(m)) },
    });
    store.add('d1', 'srf-1', input('L1'));
    expect(store.all()).toHaveLength(1);
    expect(warned.join(' ')).toContain('could not write the held messages');
  });

  it('reads a saved file that is valid JSON but not a list as nothing held', () => {
    writeFileSync(join(dir, 'held-input.json'), '{"not":"a list"}');
    expect(new HeldInputStore({ dataDir: dir, logger }).all()).toEqual([]);
  });
});

describe('a held message that expires is said in its chat, never dropped silently', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-held-exp-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('tells every surface in the chat at the moment it expires, by timer', async () => {
    let now = 1_000;
    const store = new HeldInputStore({
      dataDir: dir,
      logger,
      now: () => now,
      hostName: () => 'Studio Mac',
    });
    const told: string[] = [];
    const link = new InboundHostLink({
      logger,
      heldInputs: store,
      onHeldExpired: (expired) => told.push(...expired.map((e) => e.notice.event.chatId)),
    });
    const seen: WireEvent[] = [];
    link.onEvent((e) => seen.push(e));
    vi.useFakeTimers();
    try {
      link.sendTo('d1', 'srf-1', input('L1'));
      now += HELD_INPUT_MAX_AGE_MS + 1;
      vi.advanceTimersByTime(HELD_INPUT_MAX_AGE_MS + 2);
    } finally {
      vi.useRealTimers();
    }
    expect(told).toEqual(['c1']);
    expect(seen).toHaveLength(1);
    const err = seen[0] as Extract<WireEvent, { type: 'chat.error' }>;
    expect(err.type).toBe('chat.error');
    expect(err.chatId).toBe('c1');
    expect(err.error.code).toBe('held_message_expired');
    expect(err.error.message).toMatch(/Not delivered/);
    expect(err.error.message).toMatch(/Studio Mac/);
    expect(err.error.message).toMatch(/text L1/);

    // And when the host does come back, it gets the notice, not the message.
    const socket = new FakeSocket();
    link.attach(socket as never, 'd1');
    expect(socket.sent.map((e) => e.type)).toEqual(['chat.held_input_expired']);
    // Taken once: nothing is held for d1 any more.
    expect(store.all()).toEqual([]);
    store.stop();
  });

  it('reports a message that expired while the server was down once the server checks', () => {
    let now = 1_000;
    new HeldInputStore({ dataDir: dir, logger, now: () => now }).add('d1', 'srf-1', input('L1'));
    now += HELD_INPUT_MAX_AGE_MS + 1;
    const store = new HeldInputStore({ dataDir: dir, logger, now: () => now });
    const told: string[] = [];
    // Building the link does not report it yet: nothing is wired to hear it.
    new InboundHostLink({
      logger,
      heldInputs: store,
      onHeldExpired: (expired) => told.push(...expired.map((e) => e.notice.event.chatId)),
    });
    expect(told).toEqual([]);
    store.expireDue();
    expect(told).toEqual(['c1']);
    // Reported once.
    store.expireDue();
    expect(told).toEqual(['c1']);
    store.stop();
  });
});
