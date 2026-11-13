// Keepalive on both legs of a relayed connection. A relay (Cloudflare's among
// them) may drop a WebSocket it thinks is idle, and a dead connection can look
// open for minutes: the host pings the relay, the device pings its server
// through the session, and two unanswered pings end the connection so it is
// dialled again. The tests that need a relay or a server that goes quiet build
// one; the rest run against the relay under test (test/target.ts).

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { ed25519 } from '@noble/curves/ed25519';
import {
  RelayClient,
  RelayConnection,
  type WebSocketCtor,
  type WebSocketLike,
} from '../src/client.js';
import {
  channelFor,
  generateServerIdentity,
  serverAccept,
  toBase64Url,
  type ServerIdentity,
} from '../src/crypto.js';
import { RelayHost } from '../src/host.js';
import { budget, startRelay, type TestRelay } from './target.js';

/** The keepalive interval against the relay under test. Two missed pings end a connection, so it must outlast a stalled event loop on a loaded CI runner. */
const PING = budget(300);

let relay: TestRelay;
let target: Server;
let targetUrl: string;
const cleanup: (() => void | Promise<void>)[] = [];

beforeEach(async () => {
  relay = await startRelay();
  target = createServer((_req, res) => res.writeHead(404).end('nope'));
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;
});
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
  await new Promise<void>((r) => target.close(() => r()));
  await relay.close();
});

async function until(pick: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + budget(ms);
  while (!pick()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function startHost(identity = generateServerIdentity()): RelayHost {
  const host = new RelayHost({
    relayUrl: relay.url,
    identity,
    target: targetUrl,
    keepaliveMs: PING,
    backoffMs: { min: 20, max: 100 },
  });
  host.start();
  cleanup.push(() => host.stop());
  return host;
}

/**
 * The device's socket, which counts what it sends and can be made to go deaf
 * and dumb: the connection stays open, nothing crosses it — a dead path.
 */
class Wire implements WebSocketLike {
  static all: Wire[] = [];
  readonly inner: WebSocket;
  dead = false;
  sent = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(url: string) {
    Wire.all.push(this);
    this.inner = new WebSocket(url);
    this.inner.onopen = (ev) => this.onopen?.(ev);
    this.inner.onmessage = (ev) => {
      if (!this.dead) this.onmessage?.({ data: ev.data });
    };
    this.inner.onclose = (ev) => this.onclose?.({ code: ev.code, reason: ev.reason });
    this.inner.onerror = (ev) => this.onerror?.(ev);
  }
  get binaryType(): string {
    return this.inner.binaryType;
  }
  set binaryType(t: string) {
    this.inner.binaryType = t as 'arraybuffer';
  }
  get readyState(): number {
    return this.inner.readyState;
  }
  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.sent++;
    if (!this.dead) this.inner.send(data);
  }
  close(code?: number, reason?: string): void {
    this.inner.close(code, reason);
  }
}

const dial = (identity: ServerIdentity): RelayConnection =>
  RelayConnection.to(
    {
      url: relay.url,
      channel: channelFor(identity.publicKey),
      serverKey: toBase64Url(identity.publicKey),
    },
    { WebSocket: Wire as unknown as WebSocketCtor, keepaliveMs: PING },
  );

describe('the host’s connection to the relay', () => {
  it('pings the relay and stays connected while it answers', async () => {
    const host = startHost();
    let connects = 0;
    host.onStatus((s) => {
      if (s.connected) connects++;
    });
    await until(() => host.status().connected);
    await sleep(PING * 8);
    expect(host.status().connected).toBe(true);
    expect(connects).toBe(1);
  });

  it('is dropped and dialled again when the relay stops answering pings', async () => {
    // A relay that lets the server on, then never answers a ping.
    const quiet = new WebSocketServer({ port: 0, host: '127.0.0.1', autoPong: false });
    await new Promise<void>((r) => quiet.on('listening', () => r()));
    cleanup.push(() => new Promise<void>((r) => quiet.close(() => r())));
    let connections = 0;
    quiet.on('connection', (ws) => {
      connections++;
      ws.send(JSON.stringify({ type: 'challenge', nonce: 'n' }));
      ws.once('message', () => ws.send(JSON.stringify({ type: 'ready' })));
    });
    const host = new RelayHost({
      relayUrl: `ws://127.0.0.1:${(quiet.address() as AddressInfo).port}`,
      identity: generateServerIdentity(),
      target: targetUrl,
      keepaliveMs: 50,
      backoffMs: { min: 10, max: 20 },
    });
    const errors: (string | null)[] = [];
    host.onStatus((s) => {
      if (!s.connected) errors.push(s.lastError);
    });
    host.start();
    cleanup.push(() => host.stop());
    await until(() => host.status().connected);
    await until(() => connections >= 2, 2000);
    expect(errors).toContain('the relay stopped answering pings');
  });
});

describe('a device’s session through the relay', () => {
  it('pings its server and stays up while it answers', async () => {
    const identity = generateServerIdentity();
    const host = startHost(identity);
    await until(() => host.status().connected);
    Wire.all = [];
    const conn = dial(identity);
    cleanup.push(() => conn.close());
    expect((await conn.fetch('/x')).status).toBe(404);
    const client = await conn.session();
    const before = Wire.all[0]!.sent;
    await sleep(PING * 8);
    expect(client.closed).toBe(false);
    // Idle, it still sent: those are the pings that keep it from being dropped.
    expect(Wire.all[0]!.sent - before).toBeGreaterThanOrEqual(5);
    expect((await conn.fetch('/x')).status).toBe(404);
    expect(Wire.all).toHaveLength(1);
  });

  it('ends a session whose path has gone dead, and the route dials a fresh one', async () => {
    const identity = generateServerIdentity();
    const host = startHost(identity);
    await until(() => host.status().connected);
    Wire.all = [];
    const conn = dial(identity);
    cleanup.push(() => conn.close());
    await conn.fetch('/x');
    await sleep(PING * 3); // the server has answered a ping
    Wire.all[0]!.dead = true;
    await until(() => conn.status.state === 'offline', 2000);
    expect(conn.status.error).toMatch(/stopped answering/);
    expect((await conn.fetch('/x')).status).toBe(404);
    expect(Wire.all).toHaveLength(2);
  });

  it('stays up with a server from before pings, which never answers one', async () => {
    // An older server: it accepts the session and ignores what it does not know.
    const identity = generateServerIdentity();
    const channel = channelFor(identity.publicKey);
    const server = new WebSocket(`${relay.url}/v1/connect?channel=${channel}&role=server`);
    cleanup.push(() => server.terminate());
    let ready = false;
    let frames = 0;
    const accepted = new Set<number>();
    server.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        const m = JSON.parse(data.toString()) as { type: string; nonce?: string };
        if (m.type === 'challenge') {
          const sig = ed25519.sign(
            new TextEncoder().encode(`patch-relay-v1|${channel}|${m.nonce ?? ''}`),
            identity.secretKey,
          );
          server.send(
            JSON.stringify({
              type: 'hello',
              publicKey: toBase64Url(identity.publicKey),
              signature: toBase64Url(sig),
            }),
          );
        } else if (m.type === 'ready') ready = true;
        return;
      }
      const cid = data.readUInt32BE(0);
      if (accepted.has(cid)) {
        frames++;
        return;
      }
      accepted.add(cid);
      const reply = serverAccept(identity, new Uint8Array(data.subarray(4))).reply;
      const out = Buffer.alloc(4 + reply.length);
      out.writeUInt32BE(cid, 0);
      out.set(reply, 4);
      server.send(out);
    });
    await until(() => ready);
    const client = await RelayClient.connect(
      { url: relay.url, channel, serverKey: toBase64Url(identity.publicKey) },
      { WebSocket: WebSocket as unknown as WebSocketCtor, keepaliveMs: PING },
    );
    cleanup.push(() => client.close());
    await sleep(PING * 8);
    expect(client.closed).toBe(false);
    expect(frames).toBeGreaterThanOrEqual(5);
  });
});
