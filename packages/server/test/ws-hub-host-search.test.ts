// Host search frame routing through the hub (spec/03 § Host search).
//
// Same contract as terminal sessions: `patch.host_search.request` is the only
// frame naming a machine, so it is where the search's host is recorded for the
// `cancel` that routes by searchId alone; results and `done` route back to the
// one surface that asked.

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

function makeHub(): { hub: WsHub; link: InProcessHostLink } {
  const registry = Registry.load(mkdtempSync(join(tmpdir(), 'patch-wshub-search-')));
  const account = registry.bootstrapAccount();
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

describe('WsHub — host search frames', () => {
  it('forwards request + cancel stamped with the surfaceId, routing cancel by searchId', () => {
    const { hub, link } = makeHub();
    const socket = new FakeSocket();
    const open: WireEvent = {
      type: 'patch.host_search.request',
      hostId: 'd1',
      searchId: 'srch1',
      root: '/home/tom/projects',
      query: 'findMe',
    };
    const cancel: WireEvent = { type: 'patch.host_search.cancel', searchId: 'srch1' };
    // @ts-expect-error — reaching into a private method for direct unit coverage
    hub['handleSurfaceEvent'](conn('srf-A', socket), open, silentLogger);
    // @ts-expect-error — same
    hub['handleSurfaceEvent'](conn('srf-A', socket), cancel, silentLogger);

    expect(link.sent.map((s) => s.event.type)).toEqual([
      'patch.host_search.request',
      'patch.host_search.cancel',
    ]);
    for (const s of link.sent) {
      expect((s.event as { forSurfaceId?: string }).forSurfaceId).toBe('srf-A');
      expect(s.surfaceId).toBe('srf-A');
    }
    expect(socket.closed).toHaveLength(0);
  });

  it('drops a cancel for a searchId it never opened, instead of guessing a machine', () => {
    const { hub, link } = makeHub();
    const socket = new FakeSocket();
    // @ts-expect-error — private method
    hub['handleSurfaceEvent'](
      conn('srf-A', socket),
      { type: 'patch.host_search.cancel', searchId: 'unknown' },
      silentLogger,
    );
    expect(link.sent).toHaveLength(0);
  });

  it('routes results and done back to the one surface that searched', () => {
    const { hub, link } = makeHub();
    const a = new FakeSocket();
    const b = new FakeSocket();
    // @ts-expect-error — private map, seeded directly (no full hello handshake)
    hub['surfaces'].set('srf-A', new Set([conn('srf-A', a)]));
    // @ts-expect-error — private map, seeded directly
    hub['surfaces'].set('srf-B', new Set([conn('srf-B', b)]));

    link.emit({
      type: 'patch.host_search.result',
      searchId: 'srch1',
      matches: [{ path: 'a.ts', line: 1, column: 1, preview: 'needle' }],
      forSurfaceId: 'srf-A',
    });
    link.emit({
      type: 'patch.host_search.done',
      searchId: 'srch1',
      ok: true,
      forSurfaceId: 'srf-A',
    });

    expect(a.sent).toHaveLength(2);
    expect(decode(Buffer.from(a.sent[0]))).toMatchObject({ type: 'patch.host_search.result' });
    expect(decode(Buffer.from(a.sent[1]))).toMatchObject({
      type: 'patch.host_search.done',
      ok: true,
    });
    expect(b.sent).toHaveLength(0);
  });

  it('a cancel after done is dropped — the session table was already cleared', () => {
    const { hub, link } = makeHub();
    const socket = new FakeSocket();
    // @ts-expect-error — private method
    hub['handleSurfaceEvent'](
      conn('srf-A', socket),
      {
        type: 'patch.host_search.request',
        hostId: 'd1',
        searchId: 'srch1',
        root: '/x',
        query: 'y',
      },
      silentLogger,
    );
    link.emit({
      type: 'patch.host_search.done',
      searchId: 'srch1',
      ok: true,
      forSurfaceId: 'srf-A',
    });
    link.sent.length = 0;
    // @ts-expect-error — private method
    hub['handleSurfaceEvent'](
      conn('srf-A', socket),
      { type: 'patch.host_search.cancel', searchId: 'srch1' },
      silentLogger,
    );
    expect(link.sent).toHaveLength(0);
  });
});
