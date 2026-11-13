// Voice devices connect to the server's /device/control (spec/16 § Connection
// model): a device credential is admitted, a wake opens a session on the
// Manager's chat, and that session's audio WSS is routed to the chat's own host.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { PresenceTracker } from '../src/presence.js';
import { InProcessHostLink } from '../src/host-link.js';
import { verifyVoiceToken } from '../src/voice/token.js';

const SECRET = 'test-internal-token-not-for-prod-aaaa';
const HOST_ID = 'daemon-netcup';

class Log {
  readonly frames: Record<string, unknown>[] = [];
  closeCode: number | null = null;
  constructor(ws: WebSocket) {
    ws.on('message', (d: Buffer) => this.frames.push(JSON.parse(d.toString('utf8'))));
    ws.on('close', (code) => (this.closeCode = code));
  }
  async waitFor(pred: () => boolean, ms = 3000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > ms) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

describe('voice device control on the server', () => {
  let dir: string;
  let url: string;
  let close: () => Promise<void>;
  let user: { publicKey: string; privateKey: string };
  let registry: Registry;
  let hostLink: InProcessHostLink;
  let upstream: WebSocketServer;
  const upstreamGot: string[] = [];

  const deviceJwt = (surfaceId: string): Promise<string> =>
    mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId,
      surfaceKind: 'voice-device',
      label: 'kitchen',
    });

  const connect = (jwt: string): { ws: WebSocket; log: Log } => {
    const ws = new WebSocket(`${url}/device/control`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    return { ws, log: new Log(ws) };
  };

  const hello = (ws: WebSocket, deviceId: string): void =>
    ws.send(JSON.stringify({ type: 'hello', deviceId, fwVersion: '0.1.0', muted: false }));

  async function start(opts: { managerChat: boolean }): Promise<void> {
    dir = mkdtempSync(join(tmpdir(), 'patch-device-control-'));
    user = generateUserKeypair();
    registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.setDaemonKey({
      hostId: HOST_ID,
      publicKey: user.publicKey,
      issuedAt: Math.floor(Date.now() / 1000),
    });
    upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((r) => upstream.once('listening', r));
    upstream.on('connection', (ws) =>
      ws.on('message', (d: Buffer) => upstreamGot.push(d.toString('utf8'))),
    );
    hostLink = new InProcessHostLink();
    hostLink.setHostId(HOST_ID);
    const { app } = await buildAll({
      registry,
      presence: new PresenceTracker(),
      logger: false,
      internalToken: SECRET,
      hostLink,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    hostLink.emit({
      type: 'host.host',
      hostId: HOST_ID,
      hostName: 'Netcup',
      platform: 'linux',
      arch: 'x64',
      hostVersion: '0.1.0',
      updateAvailable: false,
      permissionModeDefault: 'default',
      permissionOverrides: 0,
      runsManager: true,
      audioRelayHost: `127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      backends: [],
      components: [],
    } as unknown as WireEvent);
    if (opts.managerChat) {
      hostLink.emit({
        type: 'chat.spawned',
        chatId: 'thread_manager',
        hostId: HOST_ID,
        folder: '/srv/manager',
      });
    }
    url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    close = () => app.close();
  }

  beforeEach(() => {
    upstreamGot.length = 0;
  });
  afterEach(async () => {
    upstream.close();
    await close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a wake opens a session on the Manager whose audio reaches the owning host', async () => {
    await start({ managerChat: true });
    const { ws, log } = connect(await deviceJwt('dev-kitchen'));
    await new Promise<void>((r) => ws.once('open', () => r()));
    hello(ws, 'dev-kitchen');
    ws.send(JSON.stringify({ type: 'wake_detected' }));
    await log.waitFor(() => log.frames.some((f) => f.type === 'session_start'));
    const start1 = log.frames.find((f) => f.type === 'session_start') as {
      sessionId: string;
      voiceToken: string;
      chatId: string;
    };
    expect(start1.chatId).toBe('thread_manager');
    expect((start1 as unknown as { followupMs: number }).followupMs).toBe(5000);
    const claims = verifyVoiceToken({ secret: SECRET, token: start1.voiceToken });
    expect(claims.surfaceId).toBe('dev-kitchen');
    expect(claims.chatId).toBe('thread_manager');

    const audio = new WebSocket(`${url}/audio/${start1.sessionId}`);
    await new Promise<void>((r) => audio.once('open', () => r()));
    audio.send('{"type":"audio.session_start"}');
    await log.waitFor(() => upstreamGot.length > 0);
    expect(upstreamGot[0]).toBe('{"type":"audio.session_start"}');
    audio.close();
    ws.close();
  });

  it('refuses a credential that is not a voice device', async () => {
    await start({ managerChat: true });
    const web = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-web',
      surfaceKind: 'web',
      label: 'browser',
    });
    const { log } = connect(web);
    await log.waitFor(() => log.closeCode !== null);
    expect(log.closeCode).toBe(4401);
  });

  it('refuses a revoked device', async () => {
    await start({ managerChat: true });
    registry.upsertSurface({
      surfaceId: 'dev-gone',
      surfaceKind: 'voice-device',
      label: 'gone',
      issuedAt: 1,
    });
    registry.revoke('dev-gone');
    const { log } = connect(await deviceJwt('dev-gone'));
    await log.waitFor(() => log.closeCode !== null);
    expect(log.closeCode).toBe(4401);
  });

  it('closes a hello that names a different device', async () => {
    await start({ managerChat: true });
    const { ws, log } = connect(await deviceJwt('dev-kitchen'));
    await new Promise<void>((r) => ws.once('open', () => r()));
    hello(ws, 'dev-someone-else');
    await log.waitFor(() => log.closeCode !== null);
    expect(log.closeCode).toBe(4401);
  });

  it('says so when no online host owns the Manager', async () => {
    await start({ managerChat: false });
    const { ws, log } = connect(await deviceJwt('dev-kitchen'));
    await new Promise<void>((r) => ws.once('open', () => r()));
    hello(ws, 'dev-kitchen');
    ws.send(JSON.stringify({ type: 'wake_detected' }));
    await log.waitFor(() => log.frames.some((f) => f.type === 'error'));
    expect(log.frames.some((f) => f.type === 'session_start')).toBe(false);
    ws.close();
  });

  it('Add device mints a voice-device token that connects, and needs a signed-in surface', async () => {
    await start({ managerChat: true });
    const http = url.replace('ws://', 'http://');
    const anon = await fetch(`${http}/api/voice-devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'kitchen' }),
    });
    expect(anon.status).toBe(401);
    const admin = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-admin',
      surfaceKind: 'web',
      label: 'browser',
    });
    const bad = await fetch(`${http}/api/voice-devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
      body: JSON.stringify({ label: '' }),
    });
    expect(bad.status).toBe(400);
    const res = await fetch(`${http}/api/voice-devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` },
      body: JSON.stringify({ label: 'kitchen' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { surfaceId: string; token: string; label: string };
    expect(body.label).toBe('kitchen');
    const { ws, log } = connect(body.token);
    await new Promise<void>((r) => ws.once('open', () => r()));
    hello(ws, body.surfaceId);
    ws.send(JSON.stringify({ type: 'wake_detected' }));
    await log.waitFor(() => log.frames.some((f) => f.type === 'session_start'));
    ws.close();
  });

  it('a speakers notify is spoken on the connected device, whose host is asked to say it', async () => {
    await start({ managerChat: true });
    hostLink.emit({ type: 'chat.spawned', chatId: 'chat-x', hostId: HOST_ID, folder: '/srv/x' });
    const { ws, log } = connect(await deviceJwt('dev-kitchen'));
    await new Promise<void>((r) => ws.once('open', () => r()));
    hello(ws, 'dev-kitchen');
    await new Promise((r) => setTimeout(r, 50));
    hostLink.emit({
      type: 'notify',
      chatId: 'chat-x',
      channel: 'speakers',
      message: 'The bus is due',
    });
    await log.waitFor(() => log.frames.some((f) => f.type === 'session_start'));
    const st = log.frames.find((f) => f.type === 'session_start') as {
      sessionId: string;
      chatId: string;
      conversational: boolean;
    };
    expect(st.chatId).toBe('chat-x');
    expect(st.conversational).toBe(false);
    const audio = new WebSocket(`${url}/audio/${st.sessionId}`);
    await new Promise<void>((r) => audio.once('open', () => r()));
    audio.send('{"type":"audio.session_start"}');
    await log.waitFor(() => upstreamGot.length >= 2);
    expect(upstreamGot[0]).toBe('{"type":"audio.session_start"}');
    expect(JSON.parse(upstreamGot[1] as string)).toEqual({
      type: 'audio.speak',
      sessionId: st.sessionId,
      text: 'The bus is due',
    });
    audio.close();
    ws.close();
  });

  it('a named speaker is matched by its label; a muted one is skipped', async () => {
    await start({ managerChat: true });
    const k = connect(await deviceJwt('dev-k'));
    const b = connect(await deviceJwt('dev-b'));
    await Promise.all([k, b].map((d) => new Promise<void>((r) => d.ws.once('open', () => r()))));
    hello(k.ws, 'dev-k');
    b.ws.send(
      JSON.stringify({ type: 'hello', deviceId: 'dev-b', fwVersion: '0.1.0', muted: true }),
    );
    await new Promise((r) => setTimeout(r, 50));
    hostLink.emit({
      type: 'notify',
      chatId: 'thread_manager',
      channel: 'speakers',
      message: 'hi',
      deviceId: 'Kitchen',
    });
    await k.log.waitFor(() => k.log.frames.some((f) => f.type === 'session_start'));
    expect(b.log.frames.some((f) => f.type === 'session_start')).toBe(false);
    k.ws.close();
    b.ws.close();
  }, 30_000);
});
