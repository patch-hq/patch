// Handing over to the phone, end to end (spec/09 § Presence heuristic, §
// Handing over to the phone): a real TCP/WS listener, real desktop sockets with
// genuine EdDSA-JWTs, the real router and handover, a real `chat.state` on the
// host link.
//
// Only the push transport is injected — there is no way to assert against
// Expo's push API from a test.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { decode, encode, type WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { PresenceTracker } from '../src/presence.js';
import { InProcessHostLink } from '../src/host-link.js';

class FrameLog {
  readonly frames: WireEvent[] = [];
  constructor(private readonly ws: WebSocket) {
    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        this.frames.push(decode(Array.isArray(raw) ? Buffer.concat(raw) : (raw as Buffer)));
      } catch {
        // ignore non-wire frames
      }
    });
  }
  /** Send a surface→server frame over this socket (e.g. `chat.focus_change`). */
  send(event: WireEvent): void {
    this.ws.send(encode(event));
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
}

describe('handing over to the phone — real server, real desktop sockets', () => {
  let dataDir: string;
  let user: { publicKey: string; privateKey: string };
  let link: InProcessHostLink;
  let pushed: { tokens: string[]; payload: { body: string; data?: Record<string, string> } }[];
  let close: () => Promise<void>;
  let port: number;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'patch-handover-int-'));
    user = generateUserKeypair();
    const registry = Registry.load(dataDir);
    registry.bootstrapAccount({ keypair: user });
    for (const id of ['srf-desktop', 'srf-desktop-2']) {
      registry.upsertSurface({
        surfaceId: id,
        surfaceKind: 'desktop',
        label: id,
        issuedAt: Math.floor(Date.now() / 1000),
      });
    }
    registry.registerPushToken({
      surfaceId: 'srf-phone',
      accountId: user.publicKey,
      token: 'tok-phone',
      registeredAt: Date.now(),
    });
    pushed = [];
    link = new InProcessHostLink();
    const { app } = await buildAll({
      registry,
      // The settings service has no store here, so the default 1 minute stands.
      presence: new PresenceTracker(),
      hostLink: link,
      pushBackend: {
        send: async (tokens, payload) => {
          pushed.push({ tokens, payload: payload as never });
          return { delivered: tokens.length, failed: [], permanentlyRejected: [] };
        },
      },
      jobsWatch: false,
      logger: false,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as AddressInfo).port;
    close = async () => {
      await app.close();
    };
  });

  afterEach(async () => {
    await close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function connect(surfaceId = 'srf-desktop'): Promise<FrameLog> {
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId,
      surfaceKind: 'desktop',
      label: surfaceId,
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const log = new FrameLog(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.send(encode({ type: 'hello', clientType: 'surface-web', clientVersion: '1', auth: jwt }));
    await log.waitForCount('auth.ok', 1);
    return log;
  }

  const report = async (
    log: FrameLog,
    idleMs: number,
    away?: 'locked' | 'asleep',
  ): Promise<void> => {
    log.send({ type: 'surface.input', idleMs, scope: 'system', ...(away ? { away } : {}) });
    await new Promise((r) => setTimeout(r, 60));
  };

  async function waitForPush(n: number, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (pushed.length < n && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  function finish(chatId: string, name: string): void {
    const base = {
      type: 'chat.state',
      chatId,
      hostId: 'd1',
      permissionMode: 'auto',
      folder: '/home/tom/projects/x',
      lastUpdated: 0,
      ts: 0,
    };
    link.emit({
      type: 'chat.spawned',
      chatId,
      hostId: 'd1',
      folder: '/home/tom/projects/x',
      seq: 1,
      ts: 0,
    } as WireEvent);
    link.emit({ ...base, activity: 'running', seq: 2, name } as WireEvent);
    link.emit({ ...base, activity: 'idle', seq: 3, name, statusSummary: 'done' } as WireEvent);
  }

  it('locking the Mac sends the toast the user never opened to the phone within seconds', async () => {
    const mac = await connect();
    await report(mac, 0);
    finish('c1', 'bed planner');
    await mac.waitForCount('notify', 1);
    expect(pushed).toHaveLength(0);

    const lockedAt = Date.now();
    await report(mac, 0, 'locked');
    await waitForPush(1);
    expect(pushed).toHaveLength(1);
    expect(Date.now() - lockedAt).toBeLessThan(2000);
    expect(pushed[0]!.payload.body).toBe('bed planner finished: done');
    expect(pushed[0]!.payload.data).toMatchObject({ chatId: 'c1' });
  });

  it('after the lock, the next notification goes straight to the phone', async () => {
    const mac = await connect();
    await report(mac, 0);
    await report(mac, 0, 'locked');
    finish('c2', 'forage');
    await waitForPush(1);
    expect(pushed).toHaveLength(1);
    expect(mac.count('notify')).toBe(0);
  });

  it('walking off unlocked hands over once idle reaches the threshold', async () => {
    const mac = await connect();
    await report(mac, 0);
    finish('c3', 'bed planner');
    await mac.waitForCount('notify', 1);
    await report(mac, 59_000);
    expect(pushed).toHaveLength(0);
    await report(mac, 60_000);
    await waitForPush(1);
    expect(pushed).toHaveLength(1);
  });

  it('several unopened notifications go as one push naming the chats', async () => {
    const mac = await connect();
    await report(mac, 0);
    finish('c4', 'bed planner');
    finish('c5', 'forage');
    await mac.waitForCount('notify', 2);
    await report(mac, 0, 'asleep');
    await waitForPush(1);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.payload.body).toMatch(/^2 notifications while you were away: /);
    expect(pushed[0]!.payload.body).toContain('bed planner');
    expect(pushed[0]!.payload.body).toContain('forage');
    expect(pushed[0]!.payload.data).toEqual({ kind: 'handover' });
  });

  it('opening the chat on any surface means it is not handed over', async () => {
    const mac = await connect();
    const other = await connect('srf-desktop-2');
    await report(mac, 0);
    finish('c6', 'bed planner');
    await mac.waitForCount('notify', 1);
    other.send({ type: 'chat.focus_change', chatId: 'c6' });
    await new Promise((r) => setTimeout(r, 60));
    await report(mac, 0, 'locked');
    await new Promise((r) => setTimeout(r, 200));
    expect(pushed).toHaveLength(0);
  });

  it('unlocking and locking again does not hand the same notification over twice', async () => {
    const mac = await connect();
    await report(mac, 0);
    finish('c7', 'bed planner');
    await mac.waitForCount('notify', 1);
    await report(mac, 0, 'locked');
    await waitForPush(1);
    await report(mac, 0);
    await report(mac, 0, 'locked');
    await new Promise((r) => setTimeout(r, 200));
    expect(pushed).toHaveLength(1);
  });

  it('Settings → Devices carries each computer’s presence', async () => {
    const mac = await connect();
    await report(mac, 4000);
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-desktop',
      surfaceKind: 'desktop',
      label: 'srf-desktop',
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    const body = (await res.json()) as {
      devices: { surfaceId: string; presence?: { state: string; idleMs?: number } }[];
    };
    const desk = body.devices.find((d) => d.surfaceId === 'srf-desktop');
    expect(desk?.presence).toMatchObject({ state: 'active' });
    expect(desk?.presence?.idleMs).toBeGreaterThanOrEqual(4000);
    const other = body.devices.find((d) => d.surfaceId === 'srf-desktop-2');
    expect(other?.presence).toMatchObject({ state: 'not-reporting' });
    await report(mac, 0, 'locked');
    const res2 = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    const body2 = (await res2.json()) as typeof body;
    expect(body2.devices.find((d) => d.surfaceId === 'srf-desktop')?.presence).toMatchObject({
      state: 'away',
      away: 'locked',
    });
  });
});
