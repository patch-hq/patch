// spec/12 § Chat status, § Continue: a host announces a planned restart, the
// server shows its working chats as Host restarting (then Host offline after
// the restart window), and on return the host's facts set the status —
// Interrupted carrying a Continue that reaches the host.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { generateUserKeypair, mintSurfaceCredential, mintDaemonKey } from '@patch/auth';
import { decode, encode, type WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { PresenceTracker } from '../src/presence.js';

/** A transcript fact goes through the host's outbox, the only way it reaches the record. */
let outboxPosition = 0;
const outbox = (event: Record<string, unknown>): string =>
  encode({ type: 'host.outbox', position: ++outboxPosition, event } as never);

class FrameLog {
  readonly frames: WireEvent[] = [];
  constructor(ws: WebSocket) {
    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        this.frames.push(decode(Array.isArray(raw) ? Buffer.concat(raw) : (raw as Buffer)));
      } catch {
        // not a wire frame
      }
    });
  }
  async until(pred: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  statuses(chatId: string): string[] {
    return this.frames
      .filter((f) => f.type === 'chat.state' && f.chatId === chatId)
      .map((f) => (f as { chatStatus?: { state: string } }).chatStatus?.state ?? '?');
  }
  has(type: WireEvent['type']): boolean {
    return this.frames.some((f) => f.type === type);
  }
}

const open = (ws: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

describe('host restart statuses', () => {
  let dataDir: string;
  let user: { publicKey: string; privateKey: string };
  let url: string;
  let close: () => Promise<void>;
  let patchSettings: (body: Record<string, unknown>) => Promise<void>;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'patch-host-restart-'));
    user = generateUserKeypair();
    const registry = Registry.load(dataDir);
    registry.bootstrapAccount({ keypair: user });
    registry.setDaemonKey({
      hostId: 'daemon-1',
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
      hostRestartWindowMs: 400,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    close = () => app.close();
    patchSettings = async (body) => {
      const jwt = await mintSurfaceCredential({
        userPrivateKey: user.privateKey,
        surfaceId: 'srf-1',
        surfaceKind: 'web',
        label: 'browser',
      });
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: { authorization: `Bearer ${jwt}` },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
    };
  });

  afterEach(async () => {
    await close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function surface(): Promise<{ ws: WebSocket; log: FrameLog }> {
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-1',
      surfaceKind: 'web',
      label: 'browser',
    });
    const ws = new WebSocket(`${url}/ws`);
    const log = new FrameLog(ws);
    await open(ws);
    ws.send(encode({ type: 'hello', clientType: 'surface-web', clientVersion: '1', auth: jwt }));
    await log.until(() => log.has('auth.ok'), 'auth.ok');
    return { ws, log };
  }

  async function host(): Promise<{ ws: WebSocket; log: FrameLog }> {
    const key = await mintDaemonKey({
      userPrivateKey: user.privateKey,
      hostId: 'daemon-1',
      label: 'h',
    });
    const ws = new WebSocket(`${url}/ws`);
    const log = new FrameLog(ws);
    await open(ws);
    ws.send(encode({ type: 'hello', clientType: 'host', clientVersion: '1', auth: key }));
    return { ws, log };
  }

  /** A host reattaching to (or starting) a turn: the turn fact, then the chat's state. */
  const running = (chatId: string): string[] => [
    outbox({ type: 'chat.turn_started', chatId, turnId: `t-${chatId}`, seq: -1, at: 1 }),
    encode({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId,
      lastUpdated: Date.now(),
    }),
  ];
  /** A host back after its machine went down: the turn it left open ended interrupted. */
  const interrupted = (chatId: string): string[] => [
    outbox({
      type: 'chat.turn_ended',
      chatId,
      turnId: `t-${chatId}`,
      seq: -1,
      at: 2,
      outcome: 'interrupted',
    }),
    encode({
      type: 'chat.state',
      permissionMode: 'bypassPermissions',
      chatId,
      interrupted: true,
      lastUpdated: Date.now(),
    }),
  ];
  const send = (ws: WebSocket, frames: string[]): void => frames.forEach((f) => ws.send(f));

  it('an announced restart shows Host restarting with no error, and the host reporting the turn live clears it', async () => {
    const s = await surface();
    const h = await host();
    await s.log.until(() => s.log.has('host.online'), 'host.online');
    h.ws.send(encode({ type: 'chat.spawned', hostId: 'daemon-1', chatId: 'c1', folder: '/p' }));
    send(h.ws, running('c1'));
    await s.log.until(() => s.log.statuses('c1').includes('running'), 'running');

    h.ws.send(encode({ type: 'host.restarting', hostId: 'daemon-1' }));
    await s.log.until(() => s.log.statuses('c1').includes('host_restarting'), 'host_restarting');
    h.ws.close();
    await s.log.until(() => s.log.has('host.offline'), 'host.offline');
    await new Promise((r) => setTimeout(r, 100));
    // The link dropping inside the window is the announced gap, not an error.
    expect(s.log.has('chat.error')).toBe(false);
    expect(s.log.statuses('c1').at(-1)).toBe('host_restarting');

    const back = await host();
    await s.log.until(
      () => s.log.frames.filter((f) => f.type === 'host.online').length >= 2,
      'back',
    );
    send(back.ws, running('c1'));
    await s.log.until(() => s.log.statuses('c1').at(-1) === 'running', 'running again');
    await new Promise((r) => setTimeout(r, 600));
    // The window no longer applies once the host reattached.
    expect(s.log.statuses('c1').at(-1)).toBe('running');
    back.ws.close();
  });

  it('a host that does not return inside the restart window reads Host offline', async () => {
    const s = await surface();
    const h = await host();
    await s.log.until(() => s.log.has('host.online'), 'host.online');
    h.ws.send(encode({ type: 'chat.spawned', hostId: 'daemon-1', chatId: 'c1', folder: '/p' }));
    send(h.ws, running('c1'));
    await s.log.until(() => s.log.statuses('c1').includes('running'), 'running');
    h.ws.send(encode({ type: 'host.restarting', hostId: 'daemon-1' }));
    await s.log.until(() => s.log.statuses('c1').includes('host_restarting'), 'host_restarting');
    h.ws.close();
    await s.log.until(() => s.log.statuses('c1').at(-1) === 'host_offline', 'host_offline', 3000);
  });

  it('an unannounced drop is Host offline straight away', async () => {
    const s = await surface();
    const h = await host();
    await s.log.until(() => s.log.has('host.online'), 'host.online');
    h.ws.send(encode({ type: 'chat.spawned', hostId: 'daemon-1', chatId: 'c1', folder: '/p' }));
    send(h.ws, running('c1'));
    await s.log.until(() => s.log.statuses('c1').includes('running'), 'running');
    h.ws.close();
    await s.log.until(() => s.log.statuses('c1').at(-1) === 'host_offline', 'host_offline');
    expect(s.log.statuses('c1')).not.toContain('host_restarting');
  });

  it('the host reporting the turn interrupted sets Interrupted, and Continue reaches the host', async () => {
    const s = await surface();
    const h = await host();
    await s.log.until(() => s.log.has('host.online'), 'host.online');
    h.ws.send(encode({ type: 'chat.spawned', hostId: 'daemon-1', chatId: 'c1', folder: '/p' }));
    send(h.ws, running('c1'));
    await s.log.until(() => s.log.statuses('c1').includes('running'), 'running');
    h.ws.close();
    await s.log.until(() => s.log.statuses('c1').at(-1) === 'host_offline', 'host_offline');

    const back = await host();
    await s.log.until(
      () => s.log.frames.filter((f) => f.type === 'host.online').length >= 2,
      'back',
    );
    send(back.ws, interrupted('c1'));
    await s.log.until(() => s.log.statuses('c1').at(-1) === 'interrupted', 'interrupted');
    // Off by default: the chat waits for the user.
    await new Promise((r) => setTimeout(r, 200));
    expect(back.log.has('chat.continue_request')).toBe(false);

    s.ws.send(encode({ type: 'chat.continue_request', chatId: 'c1' }));
    await back.log.until(() => back.log.has('chat.continue_request'), 'continue at host');
    back.ws.close();
  });

  it('with automatic continue on, the server asks the host to continue the moment it reports Interrupted', async () => {
    await patchSettings({ autoContinueInterrupted: true });
    const s = await surface();
    const h = await host();
    await s.log.until(() => s.log.has('host.online'), 'host.online');
    h.ws.send(encode({ type: 'chat.spawned', hostId: 'daemon-1', chatId: 'c1', folder: '/p' }));
    send(h.ws, running('c1'));
    await s.log.until(() => s.log.statuses('c1').includes('running'), 'running');
    h.ws.close();
    await s.log.until(() => s.log.statuses('c1').at(-1) === 'host_offline', 'host_offline');

    const back = await host();
    await s.log.until(
      () => s.log.frames.filter((f) => f.type === 'host.online').length >= 2,
      'back',
    );
    send(back.ws, interrupted('c1'));
    await back.log.until(() => back.log.has('chat.continue_request'), 'auto continue at host');
    back.ws.close();
  });
});
