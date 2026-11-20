// Terminal frame routing through the hub (spec/03 § Terminal sessions).
//
// The hub is a relay for these: it must forward the four surface→host frames
// STAMPED with the originating surfaceId (so the host streams output back to
// that surface alone), and it must route the host's output frames to that one
// surface rather than fanning them out to every connected client.

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import { decode, type WireEvent } from '@patch/wire';
import { WsHub } from '../src/ws-hub.js';
import { Registry } from '../src/registry.js';
import { PresenceTracker } from '../src/presence.js';
import { ChatRegistry } from '../src/chat-registry.js';
import { InProcessHostLink } from '../src/host-link.js';

const silentLogger = pino({ level: 'silent' });

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  closed: { code?: number; reason?: string }[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
    this.emit('close');
  }
}

function makeHub(extra: { terminalLossWindowMs?: number } = {}): {
  hub: WsHub;
  link: InProcessHostLink;
} {
  const registry = Registry.load(mkdtempSync(join(tmpdir(), 'patch-wshub-term-')));
  const account = registry.bootstrapAccount();
  // `patch.terminal.open` names a host, and the hub refuses one that is not
  // registered (spec/03 § Host events) — so the fixture registers it.
  registry.setDaemonKey({ hostId: 'd1', publicKey: account.userPublicKey, issuedAt: 1 });
  const link = new InProcessHostLink();
  const hub = new WsHub({
    logger: silentLogger,
    registry,
    presence: new PresenceTracker(),
    hostLink: link,
    chatRegistry: new ChatRegistry(),
    idGenerator: () => 'id-1',
    helloTimeoutMs: 60_000,
    ...extra,
  });
  return { hub, link };
}

function conn(surfaceId: string, socket: FakeSocket): unknown {
  return {
    socket,
    accountId: 'acc',
    surfaceId,
    surfaceKind: 'web',
    watchedChats: new Set<string>(),
  };
}

describe('WsHub — terminal frames', () => {
  it('forwards each surface→host terminal frame stamped with the surfaceId', () => {
    const { hub, link } = makeHub();
    const socket = new FakeSocket();
    const frames: WireEvent[] = [
      {
        type: 'patch.terminal.open',
        hostId: 'd1',
        sessionId: 't1',
        folder: '/home/tom/projects',
      },
      { type: 'patch.terminal.input', sessionId: 't1', data: 'git clone x\n' },
      { type: 'patch.terminal.signal', sessionId: 't1', signal: 'SIGINT' },
      // A PTY session's window change rides the same session routing.
      { type: 'patch.terminal.resize', sessionId: 't1', cols: 48, rows: 20 },
      { type: 'patch.terminal.close', sessionId: 't1' },
    ];
    for (const f of frames) {
      // @ts-expect-error — reaching into a private method for direct unit coverage
      hub['handleSurfaceEvent'](conn('srf-A', socket), f, silentLogger);
    }
    expect(link.sent.map((s) => s.event.type)).toEqual(frames.map((f) => f.type));
    for (const s of link.sent) {
      expect((s.event as { forSurfaceId?: string }).forSurfaceId).toBe('srf-A');
      expect(s.surfaceId).toBe('srf-A');
    }
    expect(socket.closed).toHaveLength(0);
  });

  it('routes host terminal output to the owning surface only', () => {
    const { hub, link } = makeHub();
    const a = new FakeSocket();
    const b = new FakeSocket();
    // @ts-expect-error — private map, seeded directly (no full hello handshake)
    hub['surfaces'].set('srf-A', new Set([conn('srf-A', a)]));
    // @ts-expect-error — private map, seeded directly
    hub['surfaces'].set('srf-B', new Set([conn('srf-B', b)]));

    link.emit({
      type: 'patch.terminal.output',
      sessionId: 't1',
      stream: 'stdout',
      data: 'Cloning into repo...\n',
      forSurfaceId: 'srf-A',
    });

    expect(a.sent).toHaveLength(1);
    expect(decode(Buffer.from(a.sent[0]))).toMatchObject({
      type: 'patch.terminal.output',
      sessionId: 't1',
    });
    expect(b.sent).toHaveLength(0);
  });
  it('tells only the owning surface its shell is lost once the host stays away', async () => {
    const { hub } = makeHub({ terminalLossWindowMs: 40 });
    const a = new FakeSocket();
    const b = new FakeSocket();
    // @ts-expect-error — private map, seeded directly
    hub['surfaces'].set('srf-A', new Set([conn('srf-A', a)]));
    // @ts-expect-error — private map, seeded directly
    hub['surfaces'].set('srf-B', new Set([conn('srf-B', b)]));
    // @ts-expect-error — private method, direct unit coverage
    hub['handleSurfaceEvent'](
      conn('srf-A', a),
      { type: 'patch.terminal.open', hostId: 'd1', sessionId: 't1' },
      silentLogger,
    );

    // @ts-expect-error — private method, direct unit coverage
    hub['announceHostStatus']('d1', 'offline');
    await new Promise((r) => setTimeout(r, 120));

    const exits = a.sent
      .map((m) => decode(Buffer.from(m)))
      .filter((e) => e.type === 'patch.terminal.exit');
    expect(exits).toMatchObject([{ sessionId: 't1', code: null, reason: 'daemon_shutdown' }]);
    expect(
      b.sent.map((m) => decode(Buffer.from(m))).filter((e) => e.type === 'patch.terminal.exit'),
    ).toHaveLength(0);
  });

  describe('a terminal session across its host going away', () => {
    const exitsOf = (sock: FakeSocket) =>
      sock.sent.map((m) => decode(Buffer.from(m))).filter((e) => e.type === 'patch.terminal.exit');
    const openPty = (hub: WsHub, sock: FakeSocket): void => {
      // @ts-expect-error — private map, seeded directly
      hub['surfaces'].set('srf-A', new Set([conn('srf-A', sock)]));
      // @ts-expect-error — private method, direct unit coverage
      hub['handleSurfaceEvent'](
        conn('srf-A', sock),
        { type: 'patch.terminal.open', hostId: 'd1', sessionId: 't1', pty: { cols: 80, rows: 24 } },
        silentLogger,
      );
    };
    const goOffline = (hub: WsHub): void => {
      // @ts-expect-error — private method, direct unit coverage
      hub['announceHostStatus']('d1', 'offline');
    };

    it('keeps its route and tells the surface nothing while the host is away', () => {
      const { hub } = makeHub();
      const a = new FakeSocket();
      openPty(hub, a);
      goOffline(hub);
      expect(exitsOf(a)).toEqual([]);
      expect(hub['terminalSessionHost'].get('t1')).toBe('d1');
      // The surface can still address it: its keystrokes are not refused.
      // @ts-expect-error — private method, direct unit coverage
      hub['handleSurfaceEvent'](
        conn('srf-A', a),
        { type: 'patch.terminal.input', sessionId: 't1', data: 'ls\r' },
        silentLogger,
      );
      const errors = a.sent
        .map((m) => decode(Buffer.from(m)))
        .filter((e) => e.type === 'patch.terminal.error');
      expect(errors).toEqual([]);
    });

    it('a host that returns inside the window keeps the session, and no loss is ever reported', async () => {
      const { hub, link } = makeHub({ terminalLossWindowMs: 40 });
      const a = new FakeSocket();
      openPty(hub, a);
      goOffline(hub);
      link.addOnlineHost('d1');
      await new Promise((r) => setTimeout(r, 120));
      expect(exitsOf(a)).toEqual([]);
      expect(hub['terminalSessionHost'].get('t1')).toBe('d1');
    });

    it('is reported lost only once the host has stayed away past the window', async () => {
      const { hub } = makeHub({ terminalLossWindowMs: 40 });
      const a = new FakeSocket();
      openPty(hub, a);
      goOffline(hub);
      expect(exitsOf(a)).toEqual([]);
      await new Promise((r) => setTimeout(r, 120));
      expect(exitsOf(a)).toMatchObject([
        { sessionId: 't1', code: null, reason: 'daemon_shutdown' },
      ]);
      expect(hub['terminalSessionHost'].has('t1')).toBe(false);
    });

    it('a pipe session outlives the host going away too: its shell runs under its own runner', () => {
      const { hub } = makeHub();
      const a = new FakeSocket();
      openPty(hub, a);
      // @ts-expect-error — private method, direct unit coverage
      hub['handleSurfaceEvent'](
        conn('srf-A', a),
        { type: 'patch.terminal.open', hostId: 'd1', sessionId: 'pipe1' },
        silentLogger,
      );
      goOffline(hub);
      expect(exitsOf(a)).toEqual([]);
      expect(hub['terminalSessionHost'].get('pipe1')).toBe('d1');
      expect(hub['terminalSessionHost'].get('t1')).toBe('d1');
    });
  });
});
