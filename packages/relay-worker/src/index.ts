// The relay (spec/10 § Relay) as a Cloudflare Worker: the same wire protocol as
// packages/relay/src/server.ts, with one Durable Object per channel holding that
// channel's server and devices. The sockets are hibernatable — accepted with
// `ctx.acceptWebSocket` and described by tags and a serialized attachment rather
// than by memory — so a channel that is connected but quiet costs nothing, and
// everything below is written to survive the object being evicted between any
// two events. Run the relay suite against it with `pnpm test` (see test/run.mjs).
//
//   GET /v1/connect?channel=<id>&role=server|client      (WebSocket)
//   GET /healthz
//
// Close codes are the Node relay's: 4400 bad request, 4401 server not proven,
// 4404 server offline, 4408 no hello in time, 4409 replaced, 4410 closed by the
// server, 4429 channel full, 4503 server went away, 1009 message too large.

import { DurableObject } from 'cloudflare:workers';
import { channelFor, fromBase64Url } from '@patch/relay';

export interface Env {
  CHANNEL: DurableObjectNamespace<Channel>;
  /** Devices allowed on one channel at once. */
  MAX_CLIENTS_PER_CHANNEL?: string;
  /** Largest message the relay forwards. */
  MAX_MESSAGE_BYTES?: string;
  /** How long a connecting server has to answer the challenge. */
  HELLO_TIMEOUT_MS?: string;
}

interface Limits {
  maxClientsPerChannel: number;
  maxMessageBytes: number;
  helloTimeoutMs: number;
}

function limits(env: Env): Limits {
  const num = (name: keyof Env, value: string | undefined, dflt: number): number => {
    if (value === undefined || value === '') return dflt;
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
    return n;
  };
  return {
    maxClientsPerChannel: num('MAX_CLIENTS_PER_CHANNEL', env.MAX_CLIENTS_PER_CHANNEL, 16),
    maxMessageBytes: num('MAX_MESSAGE_BYTES', env.MAX_MESSAGE_BYTES, 128 * 1024),
    helloTimeoutMs: num('HELLO_TIMEOUT_MS', env.HELLO_TIMEOUT_MS, 10_000),
  };
}

const CHANNEL_RE = /^[A-Za-z0-9_-]{22}$/;

/** Accept a socket only to close it with a code: how a WebSocket is refused with a reason. */
function refuse(code: number, reason: string): Response {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].close(code, reason);
  return new Response(null, { status: 101, webSocket: pair[0] });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/healthz') {
      return Response.json({ ok: true, limits: limits(env) });
    }
    if (url.pathname !== '/v1/connect') return new Response('not found', { status: 404 });
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a WebSocket', { status: 426 });
    }
    const channel = url.searchParams.get('channel') ?? '';
    const role = url.searchParams.get('role');
    if (!CHANNEL_RE.test(channel) || (role !== 'server' && role !== 'client')) {
      return refuse(4400, 'bad request');
    }
    return env.CHANNEL.get(env.CHANNEL.idFromName(channel)).fetch(req);
  },
} satisfies ExportedHandler<Env>;

/** What each socket carries across hibernation. */
type Attachment =
  | { role: 'server'; state: 'pending'; nonce: string; deadline: number }
  /** `nextCid` lives here so it outlasts hibernation, and goes when the server does, as in the Node relay. */
  | { role: 'server'; state: 'ready'; nextCid: number }
  | { role: 'server'; state: 'replaced' }
  | { role: 'client'; cid: number };

const OPEN = 1;
const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function byteLength(msg: string | ArrayBuffer): number {
  return typeof msg === 'string' ? enc.encode(msg).length : msg.byteLength;
}

function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    /* already closing */
  }
}

export class Channel extends DurableObject<Env> {
  private readonly limits: Limits;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.limits = limits(env);
  }

  private attachment(ws: WebSocket): Attachment | null {
    return ws.deserializeAttachment() as Attachment | null;
  }

  private open(tag: string): WebSocket[] {
    return this.ctx.getWebSockets(tag).filter((ws) => ws.readyState === OPEN);
  }

  /** The server that holds this channel right now, if one does. */
  private server(): WebSocket | null {
    return (
      this.open('server').find((ws) => {
        const a = this.attachment(ws);
        return a?.role === 'server' && a.state === 'ready';
      }) ?? null
    );
  }

  /** Devices on the channel. A device's attachment is cleared as it leaves. */
  private clients(): { ws: WebSocket; cid: number }[] {
    const out: { ws: WebSocket; cid: number }[] = [];
    for (const ws of this.open('client')) {
      const a = this.attachment(ws);
      if (a?.role === 'client') out.push({ ws, cid: a.cid });
    }
    return out;
  }

  private client(cid: number): WebSocket | null {
    return this.clients().find((c) => c.cid === cid)?.ws ?? null;
  }

  /** The next device number on this server's connection, which only goes up. */
  private nextCid(server: WebSocket): number {
    const a = this.attachment(server);
    if (a?.role !== 'server' || a.state !== 'ready') throw new Error('no server holds the channel');
    server.serializeAttachment({ ...a, nextCid: a.nextCid + 1 } satisfies Attachment);
    return a.nextCid;
  }

  override async fetch(req: Request): Promise<Response> {
    const role = new URL(req.url).searchParams.get('role');
    if (role === 'server') return this.acceptServer();
    return this.acceptClient();
  }

  private async acceptServer(): Promise<Response> {
    const pair = new WebSocketPair();
    const ws = pair[1];
    this.ctx.acceptWebSocket(ws, ['server']);
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(24)));
    const deadline = Date.now() + this.limits.helloTimeoutMs;
    ws.serializeAttachment({
      role: 'server',
      state: 'pending',
      nonce,
      deadline,
    } satisfies Attachment);
    ws.send(JSON.stringify({ type: 'challenge', nonce }));
    await this.scheduleHelloAlarm();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private acceptClient(): Response {
    const server = this.server();
    if (!server) return refuse(4404, 'server offline');
    if (this.clients().length >= this.limits.maxClientsPerChannel) {
      return refuse(4429, 'channel full');
    }
    const pair = new WebSocketPair();
    const ws = pair[1];
    const cid = this.nextCid(server);
    this.ctx.acceptWebSocket(ws, ['client']);
    ws.serializeAttachment({ role: 'client', cid } satisfies Attachment);
    server.send(JSON.stringify({ type: 'open', cid }));
    ws.send(JSON.stringify({ type: 'ready' }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** The alarm fires at the earliest hello deadline still outstanding. */
  private async scheduleHelloAlarm(): Promise<void> {
    let earliest = Infinity;
    for (const ws of this.open('server')) {
      const a = this.attachment(ws);
      if (a?.role === 'server' && a.state === 'pending') earliest = Math.min(earliest, a.deadline);
    }
    if (earliest === Infinity) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > earliest) await this.ctx.storage.setAlarm(earliest);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    for (const ws of this.open('server')) {
      const a = this.attachment(ws);
      if (a?.role === 'server' && a.state === 'pending' && a.deadline <= now) {
        ws.serializeAttachment({ role: 'server', state: 'replaced' } satisfies Attachment);
        closeQuietly(ws, 4408, 'no hello');
      }
    }
    await this.scheduleHelloAlarm();
  }

  override async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    if (byteLength(msg) > this.limits.maxMessageBytes) {
      closeQuietly(ws, 1009, 'message too large');
      return;
    }
    const a = this.attachment(ws);
    if (!a) return;
    if (a.role === 'client') return this.fromClient(ws, a.cid, msg);
    if (a.state === 'pending') return this.hello(ws, a.nonce, msg);
    if (a.state === 'ready') return this.fromServer(ws, msg);
  }

  private async hello(ws: WebSocket, nonce: string, msg: string | ArrayBuffer): Promise<void> {
    const channel = this.ctx.id.name;
    let proven = false;
    try {
      if (typeof msg !== 'string') throw new Error('binary hello');
      if (!channel) throw new Error('the channel object has no name');
      const hello = JSON.parse(msg) as { publicKey?: string; signature?: string };
      const pub = fromBase64Url(hello.publicKey ?? '');
      if (channelFor(pub) === channel) {
        const key = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, [
          'verify',
        ]);
        proven = await crypto.subtle.verify(
          { name: 'Ed25519' },
          key,
          fromBase64Url(hello.signature ?? ''),
          enc.encode(`patch-relay-v1|${channel}|${nonce}`),
        );
      }
    } catch {
      proven = false;
    }
    if (ws.readyState !== OPEN) return; // timed out while verifying
    if (!proven) {
      ws.serializeAttachment({ role: 'server', state: 'replaced' } satisfies Attachment);
      closeQuietly(ws, 4401, 'not the server of this channel');
      return;
    }
    const previous = this.server();
    const held = previous ? this.attachment(previous) : null;
    // Devices on a replaced connection stay, so their numbers are not handed out again.
    const nextCid = held?.role === 'server' && held.state === 'ready' ? held.nextCid : 1;
    ws.serializeAttachment({ role: 'server', state: 'ready', nextCid } satisfies Attachment);
    if (previous) {
      previous.serializeAttachment({ role: 'server', state: 'replaced' } satisfies Attachment);
      closeQuietly(previous, 4409, 'replaced');
    }
    ws.send(JSON.stringify({ type: 'ready' }));
    // Devices that were on the replaced connection are still here: tell the new one.
    for (const { cid } of this.clients()) ws.send(JSON.stringify({ type: 'open', cid }));
  }

  private fromServer(ws: WebSocket, msg: string | ArrayBuffer): void {
    if (typeof msg !== 'string') {
      if (msg.byteLength < 4) return;
      const cid = new DataView(msg).getUint32(0);
      this.client(cid)?.send(msg.slice(4));
      return;
    }
    try {
      const control = JSON.parse(msg) as { type?: string; cid?: number };
      if (control.type === 'close' && typeof control.cid === 'number') {
        const client = this.client(control.cid);
        if (client) closeQuietly(client, 4410, 'closed by the server');
      }
    } catch {
      closeQuietly(ws, 4400, 'bad control message');
    }
  }

  private fromClient(ws: WebSocket, cid: number, msg: string | ArrayBuffer): void {
    if (typeof msg === 'string') {
      // Control is the relay's alone; a device cannot speak to the server in it.
      closeQuietly(ws, 4400, 'binary only');
      return;
    }
    const framed = new Uint8Array(4 + msg.byteLength);
    new DataView(framed.buffer).setUint32(0, cid);
    framed.set(new Uint8Array(msg), 4);
    this.server()?.send(framed);
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.gone(ws);
    // Answer the close so the far end sees its own code back; 1005/1006 are not sendable.
    closeQuietly(ws, code === 1005 || code === 1006 ? 1000 : code, reason);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.gone(ws);
  }

  private gone(ws: WebSocket): void {
    const a = this.attachment(ws);
    if (!a) return;
    if (a.role === 'client') {
      ws.serializeAttachment(null);
      const server = this.server();
      if (server) server.send(JSON.stringify({ type: 'close', cid: a.cid }));
      return;
    }
    ws.serializeAttachment({ role: 'server', state: 'replaced' } satisfies Attachment);
    if (a.state !== 'ready') return; // replaced: the devices moved to the newer connection
    if (this.server()) return;
    for (const { ws: client } of this.clients()) {
      client.serializeAttachment(null);
      closeQuietly(client, 4503, 'server went away');
    }
  }
}
