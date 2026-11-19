// The server is the record of live voice calls (spec/07 § A call can move
// between devices). A surface's call-in-progress strip used to be driven by
// `voice.call` changes alone, so one missed `active: false` (a reconnect, a
// host restart) left it up for good. These pin the state the server now keeps:
// replayed to every surface in its greeting, replaced by a host's snapshot on
// reconnect, and dropped when the host goes offline.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { WireTestClient } from '@patch/wire/test-client';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

const CALL = {
  sessionId: 'sess-1',
  surfaceId: 'phone-1',
  surfaceKind: 'mobile',
  chatId: 'c1',
  startedAt: 5,
};

describe('WS hub — live voice calls', () => {
  let dir: string;
  let hostLink: InProcessHostLink;
  let built: Awaited<ReturnType<typeof buildAll>>;
  let url: string;
  let registry: Registry;
  const user = generateUserKeypair(() => new Uint8Array(32).fill(91));
  let n = 0;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'patch-wshub-calls-'));
    registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.setDaemonKey({ hostId: 'd1', publicKey: user.publicKey, issuedAt: 1 });
    hostLink = new InProcessHostLink();
    built = await buildAll({ logger: false, registry, hostLink, hostOfflineGraceMs: 0 });
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    url = `ws://127.0.0.1:${(built.app.server.address() as AddressInfo).port}/ws`;
  });
  afterEach(async () => {
    await built.app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Connect a surface and return it with the `voice.calls` from its greeting. */
  async function connect(): Promise<{
    client: WireTestClient;
    greeting: { calls: unknown[] };
  }> {
    const surfaceId = `srf-${++n}`;
    registry.upsertSurface({ surfaceId, surfaceKind: 'web', label: 'browser', issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId,
      surfaceKind: 'web',
      label: 'browser',
    });
    const client = new WireTestClient({ url, auth: jwt });
    const greeting = client.waitFor('voice.calls');
    await client.connect();
    return { client, greeting: await greeting };
  }

  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

  it('greets a surface with no calls when none are live', async () => {
    const { client, greeting } = await connect();
    expect(greeting).toEqual({ type: 'voice.calls', calls: [] });
    await client.close();
  });

  it('a surface that connects after a call opened gets it in its greeting; after it ended, not', async () => {
    hostLink.emit({ type: 'voice.call', ...CALL, active: true });
    await settle();
    const first = await connect();
    expect(first.greeting.calls).toEqual([CALL]);
    await first.client.close();

    hostLink.emit({ type: 'voice.call', ...CALL, active: false });
    await settle();
    const second = await connect();
    expect(second.greeting.calls).toEqual([]);
    await second.client.close();
  });

  it("a host's reconnect snapshot replaces what it held, so a call whose end was missed is cleared", async () => {
    hostLink.emit({ type: 'voice.call', ...CALL, active: true });
    await settle();
    const { client } = await connect();
    // The host reconnects holding no calls (the `active: false` was lost).
    const cleared = client.waitFor('voice.calls');
    hostLink.emit({ type: 'voice.calls', hostId: 'd1', calls: [] });
    expect((await cleared).calls).toEqual([]);
    await client.close();

    const late = await connect();
    expect(late.greeting.calls).toEqual([]);
    await late.client.close();
  });

  it('keeps calls from other hosts when one host snapshots', async () => {
    hostLink.addOnlineHost('d2');
    const other = { ...CALL, sessionId: 'sess-2', chatId: 'c2' };
    hostLink.emit({ type: 'voice.call', ...other, active: true }, 'd2');
    hostLink.emit({ type: 'voice.call', ...CALL, active: true }, 'd1');
    await settle();
    const { client } = await connect();
    const next = client.waitFor('voice.calls');
    hostLink.emit({ type: 'voice.calls', hostId: 'd1', calls: [] }, 'd1');
    expect((await next).calls).toEqual([other]);
    await client.close();
  });

  it('a host going offline ends its calls on every surface', async () => {
    hostLink.emit({ type: 'voice.call', ...CALL, active: true });
    await settle();
    const { client, greeting } = await connect();
    expect(greeting.calls).toEqual([CALL]);
    const cleared = client.waitFor('voice.calls');
    hostLink.setStatus('offline');
    expect((await cleared).calls).toEqual([]);
    await client.close();
  });
});
