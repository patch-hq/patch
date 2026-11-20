// A chat must never be left reading Running once its host has gone silent, and
// must never read Failed because a connection dropped (spec/12 § Chat status).
//
// A host reports facts: a turn started, a turn ended. When the host↔server
// link drops while a turn is open, no end will arrive until the host returns,
// so the server makes the chat Host offline. It invents no error: the turn may
// still be running, and the host's outbox catches the record up when it comes
// back. On return the facts the host reports set the status again.
//
// This exercises the REAL socket-close path: a genuine host `ws` socket
// authenticates, starts a turn, then its socket is dropped.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { generateUserKeypair, mintSurfaceCredential, mintDaemonKey } from '@patch/auth';
import { decode, encode, type WireEvent, type ChatStateEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { PresenceTracker } from '../src/presence.js';

/** Persistent frame recorder + awaiter (same shape as b1-real-ws.test.ts). */
class FrameLog {
  readonly frames: WireEvent[] = [];
  constructor(ws: WebSocket) {
    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        this.frames.push(decode(Array.isArray(raw) ? Buffer.concat(raw) : (raw as Buffer)));
      } catch {
        // ignore non-wire frames
      }
    });
  }
  count(type: WireEvent['type']): number {
    return this.frames.filter((f) => f.type === type).length;
  }
  async waitForCount(type: WireEvent['type'], n: number, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (this.count(type) < n) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`timeout waiting for ${n}× ${type} (saw ${this.count(type)})`);
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  find<T extends WireEvent['type']>(
    type: T,
    pred: (f: Extract<WireEvent, { type: T }>) => boolean,
  ): Extract<WireEvent, { type: T }> | undefined {
    return this.frames.filter((f) => f.type === type).find(pred as never) as never;
  }
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

describe('a host gone silent mid-turn makes its chats Host offline', () => {
  let dataDir: string;
  let user: { publicKey: string; privateKey: string };
  let close: () => Promise<void>;
  let url: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'patch-offline-'));
    user = generateUserKeypair();

    const registry = Registry.load(dataDir);
    registry.bootstrapAccount({ keypair: user });
    registry.setDaemonKey({
      hostId: 'daemon-1',
      publicKey: user.publicKey,
      issuedAt: Math.floor(Date.now() / 1000),
    });
    // A second registered host — spec/12 § Hosts fail independently: one
    // host going down must not resolve another host's turns.
    registry.setDaemonKey({
      hostId: 'daemon-2',
      publicKey: user.publicKey,
      issuedAt: Math.floor(Date.now() / 1000),
    });
    registry.upsertSurface({
      surfaceId: 'srf-1',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: Math.floor(Date.now() / 1000),
    });

    const { app } = await buildAll({
      registry,
      presence: new PresenceTracker(),
      logger: false,
      hostOfflineGraceMs: 0,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as AddressInfo;
    url = `ws://127.0.0.1:${addr.port}`;
    close = async () => {
      await app.close();
    };
  });

  afterEach(async () => {
    await close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function connectSurface(): Promise<{ ws: WebSocket; log: FrameLog }> {
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-1',
      surfaceKind: 'web',
      label: 'browser',
    });
    const ws = new WebSocket(`${url}/ws`);
    const log = new FrameLog(ws);
    await waitOpen(ws);
    ws.send(encode({ type: 'hello', clientType: 'surface-web', clientVersion: '1', auth: jwt }));
    await log.waitForCount('auth.ok', 1);
    return { ws, log };
  }

  async function connectHost(hostId = 'daemon-1'): Promise<WebSocket> {
    const key = await mintDaemonKey({ userPrivateKey: user.privateKey, hostId, label: hostId });
    const ws = new WebSocket(`${url}/ws`);
    await waitOpen(ws);
    ws.send(encode({ type: 'hello', clientType: 'host', clientVersion: '1', auth: key }));
    return ws;
  }

  /** What a host sends when a turn starts: the fact, then the chat's state. No activity. */
  function startTurn(ws: WebSocket, hostId: string, chatId: string): void {
    ws.send(encode({ type: 'chat.spawned', hostId, chatId, folder: '/proj' }));
    ws.send(encode({ type: 'chat.turn_started', chatId, turnId: `t-${chatId}`, seq: -1, at: 1 }));
    ws.send(
      encode({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId,
        lastUpdated: Date.now(),
      }),
    );
  }

  /** Each status the surface was shown for the chat, a repeat of the last counted once. */
  const statuses = (log: FrameLog, chatId: string): string[] =>
    log.frames
      .filter((f): f is ChatStateEvent => f.type === 'chat.state' && f.chatId === chatId)
      .map((f) => f.chatStatus?.state ?? '?')
      .filter((s, i, all) => i === 0 || all[i - 1] !== s);

  async function until(pred: () => boolean, what: string): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > 3000) throw new Error(`timeout waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('a chat left running when the host socket drops reads Host offline, with no error', async () => {
    const surface = await connectSurface();
    const host = await connectHost();
    await surface.log.waitForCount('host.online', 1);
    const chatId = 'chat-inflight-1';
    startTurn(host, 'daemon-1', chatId);
    await until(() => statuses(surface.log, chatId).includes('running'), 'running');

    host.close();
    await surface.log.waitForCount('host.offline', 1);
    await until(() => statuses(surface.log, chatId).at(-1) === 'host_offline', 'host_offline');
    // Never a false "failed", and never a stale "running".
    expect(surface.log.count('chat.error')).toBe(0);
    expect(statuses(surface.log, chatId)).not.toContain('failed');
    surface.ws.close();
  });

  it('only the dropped host’s chats go Host offline — another host keeps running', async () => {
    const surface = await connectSurface();
    const h1 = await connectHost('daemon-1');
    const h2 = await connectHost('daemon-2');
    await surface.log.waitForCount('host.online', 2);
    startTurn(h1, 'daemon-1', 'chat-on-1');
    startTurn(h2, 'daemon-2', 'chat-on-2');
    await until(() => statuses(surface.log, 'chat-on-2').includes('running'), 'running');

    h1.close();
    await until(() => statuses(surface.log, 'chat-on-1').at(-1) === 'host_offline', 'offline');
    expect(statuses(surface.log, 'chat-on-2')).toEqual(['running']);
    h2.close();
    surface.ws.close();
  });

  it('the host coming back with the turn still live returns the chat to Running, everywhere', async () => {
    const surface = await connectSurface();
    const host = await connectHost();
    await surface.log.waitForCount('host.online', 1);
    const chatId = 'chat-blip';
    startTurn(host, 'daemon-1', chatId);
    await until(() => statuses(surface.log, chatId).includes('running'), 'running');
    host.close();
    await until(() => statuses(surface.log, chatId).at(-1) === 'host_offline', 'host_offline');

    // It reattaches to the turn it was running and speaks for the chat again.
    const back = await connectHost();
    await surface.log.waitForCount('host.online', 2);
    back.send(
      encode({
        type: 'chat.state',
        permissionMode: 'bypassPermissions',
        chatId,
        lastUpdated: Date.now(),
      }),
    );
    await until(() => statuses(surface.log, chatId).at(-1) === 'running', 'running again');
    expect(statuses(surface.log, chatId)).toEqual(['running', 'host_offline', 'running']);

    // A REST cold start agrees with the live stream.
    const httpUrl = url.replace('ws://', 'http://');
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-1',
      surfaceKind: 'web',
      label: 'browser',
    });
    const res = await fetch(`${httpUrl}/api/chats`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    const body = (await res.json()) as {
      chats: { chatId: string; chatStatus?: { state: string } }[];
    };
    expect(body.chats.find((c) => c.chatId === chatId)?.chatStatus?.state).toBe('running');
    back.close();
    surface.ws.close();
  });

  it('a fast reconnect (same hostId, new socket) makes a running chat Host offline without the old socket ever closing', async () => {
    // A host process that crashes and comes back as a NEW process for the
    // same hostId before the old socket's `close` fires: the reattach itself
    // is the restart. The old socket here is simply abandoned.
    const surface = await connectSurface();
    const d1 = await connectHost();
    await surface.log.waitForCount('host.online', 1);
    const chatId = 'chat-fast-reconnect';
    startTurn(d1, 'daemon-1', chatId);
    await until(() => statuses(surface.log, chatId).includes('running'), 'running');

    const d1b = await connectHost();
    await until(() => statuses(surface.log, chatId).at(-1) === 'host_offline', 'host_offline');
    expect(surface.log.count('chat.error')).toBe(0);
    // The new process's presence is reported online too.
    await surface.log.waitForCount('host.online', 2);
    d1b.close();
    surface.ws.close();
  });
});
