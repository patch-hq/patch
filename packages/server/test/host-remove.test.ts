// DELETE /api/hosts/:hostId — remove a machine from the account
// (Settings → Hosts → "Remove this host").
//
// Real sockets both ways: a host dialled in through the real host gate
// (InboundHostLink), and a surface. Removing the machine has to do four
// things, each of which is checked here rather than trusted: revoke its
// credential (its next hello is answered `auth.revoked`), close its live link,
// drop it from every roster, and tell the surfaces `host.removed` so their host
// list drops it without a reload.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { generateUserKeypair, mintDaemonKey, mintSurfaceCredential } from '@patch/auth';
import { WireTestClient } from '@patch/wire/test-client';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patch-host-remove-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function setup(opts: { hostLink?: InProcessHostLink } = {}) {
  const user = generateUserKeypair(() => new Uint8Array(32).fill(91));
  const registry = Registry.load(dir);
  registry.bootstrapAccount({ keypair: user });
  registry.setDaemonKey({ hostId: 'host-a', publicKey: user.publicKey, issuedAt: 1 });
  registry.setDaemonKey({ hostId: 'host-b', publicKey: user.publicKey, issuedAt: 1 });
  registry.upsertSurface({ surfaceId: 'srf-rm', surfaceKind: 'web', label: 'web', issuedAt: 1 });
  const surfaceJwt = await mintSurfaceCredential({
    userPrivateKey: user.privateKey,
    surfaceId: 'srf-rm',
    surfaceKind: 'web',
    label: 'web',
  });
  const built = await buildAll({
    logger: false as never,
    registry,
    ...(opts.hostLink ? { hostLink: opts.hostLink } : {}),
    jobsWatch: false,
  });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const url = `ws://127.0.0.1:${(built.app.server.address() as AddressInfo).port}/ws`;
  const daemonKey = (hostId: string) =>
    mintDaemonKey({ userPrivateKey: user.privateKey, hostId, label: hostId });
  const remove = (hostId: string, auth: string | null = surfaceJwt) =>
    built.app.inject({
      method: 'DELETE',
      url: `/api/hosts/${hostId}`,
      ...(auth ? { headers: { authorization: `Bearer ${auth}` } } : {}),
    });
  const hostIds = async (): Promise<string[]> =>
    (
      await built.app.inject({
        method: 'GET',
        url: '/api/hosts',
        headers: { authorization: `Bearer ${surfaceJwt}` },
      })
    )
      .json()
      .hosts.map((h: { hostId: string }) => h.hostId);
  return { registry, built, url, surfaceJwt, daemonKey, remove, hostIds };
}

describe('DELETE /api/hosts/:hostId', () => {
  it('revokes the machine, closes its link, drops it from the roster and tells surfaces host.removed', async () => {
    const s = await setup();
    const daemon = new WireTestClient({
      url: s.url,
      clientType: 'host',
      auth: await s.daemonKey('host-b'),
    });
    const surface = new WireTestClient({ url: s.url, auth: s.surfaceJwt });
    try {
      await daemon.connect();
      await daemon.waitFor('auth.ok');
      // The machine reports itself, so the server has a cached description to
      // forget.
      daemon.send({
        type: 'host.host',
        hostId: 'host-b',
        hostName: 'box-b',
        platform: 'linux',
        arch: 'x64',
        hostVersion: '0.0.0',
        updateAvailable: false,
        permissionModeDefault: 'auto',
        permissionOverrides: 0,
        runsManager: false,
        audioRelayHost: '127.0.0.1:3003',
        backends: [],
        components: [],
      } as never);
      await surface.connect();
      const greeting = await surface.waitFor('auth.ok');
      expect(greeting.hosts?.map((h) => h.hostId)).toContain('host-b');

      const hostClosed = new Promise<number>((resolve) => daemon.onClose((code) => resolve(code)));
      const removed = surface.waitFor('host.removed');
      const offline = surface.waitFor('host.offline', (e) => e.hostId === 'host-b');

      const res = await s.remove('host-b');
      expect(res.statusCode).toBe(200);
      expect(res.json().hosts.map((h: { hostId: string }) => h.hostId)).toEqual(['host-a']);

      // The surface is told, naming the machine.
      expect(await removed).toEqual({ type: 'host.removed', hostId: 'host-b' });
      await offline;
      // Its live link is closed…
      await hostClosed;
      // …its credential is revoked, and every roster has forgotten it.
      expect(s.registry.isRevoked('host-b')).toBe(true);
      expect(s.registry.registeredHostIds()).toEqual(['host-a']);
      expect(await s.hostIds()).toEqual(['host-a']);

      // A surface connecting now is not greeted with it either.
      const late = new WireTestClient({ url: s.url, auth: s.surfaceJwt });
      try {
        await late.connect();
        const lateGreeting = await late.waitFor('auth.ok');
        expect(lateGreeting.hosts?.map((h) => h.hostId)).toEqual(['host-a']);
      } finally {
        await late.close().catch(() => undefined);
      }

      // The machine cannot come back with the key it had: its hello is refused
      // as REVOKED, the signal that tells it to wipe that key.
      const again = new WireTestClient({
        url: s.url,
        clientType: 'host',
        auth: await s.daemonKey('host-b'),
      });
      try {
        await again.connect();
        expect(await again.waitFor('auth.revoked')).toMatchObject({ reason: 'host revoked' });
      } finally {
        await again.close().catch(() => undefined);
      }
    } finally {
      await daemon.close().catch(() => undefined);
      await surface.close().catch(() => undefined);
      await s.built.app.close();
    }
  });

  it('refuses an unknown or already-removed machine with 404, naming it', async () => {
    const s = await setup();
    try {
      const unknown = await s.remove('host-z');
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({ error: 'unknown_host', hostId: 'host-z' });

      expect((await s.remove('host-b')).statusCode).toBe(200);
      const twice = await s.remove('host-b');
      expect(twice.statusCode).toBe(404);
      expect(twice.json().knownHosts).toEqual(['host-a']);
    } finally {
      await s.built.app.close();
    }
  });

  it('refuses a caller without a live surface credential, and removes nothing', async () => {
    const s = await setup();
    try {
      expect((await s.remove('host-b', null)).statusCode).toBe(401);
      expect((await s.remove('host-b', 'not-a-jwt')).statusCode).toBe(401);
      // A host's key is not a surface credential: a machine cannot remove
      // another one.
      expect((await s.remove('host-b', await s.daemonKey('host-a'))).statusCode).toBe(401);
      expect(s.registry.registeredHostIds()).toEqual(['host-a', 'host-b']);
    } finally {
      await s.built.app.close();
    }
  });

  it('greets surfaces with the registry name of a machine that has not reported', async () => {
    const s = await setup();
    s.registry.setHostName('host-b', 'hetzner');
    const surface = new WireTestClient({ url: s.url, auth: s.surfaceJwt });
    try {
      await surface.connect();
      const greeting = await surface.waitFor('auth.ok');
      const b = greeting.hosts?.find((h) => h.hostId === 'host-b');
      expect(b?.host).toBeNull();
      expect(b?.registeredName).toBe('hetzner');
    } finally {
      await surface.close().catch(() => undefined);
      await s.built.app.close();
    }
  });

  it('passes the Manager to the next machine when its machine is removed, and tells that machine', async () => {
    const hostLink = new InProcessHostLink();
    hostLink.setHostId('host-a');
    hostLink.addOnlineHost('host-b');
    const s = await setup({ hostLink });
    s.registry.setManagerHostId('host-b');
    const surface = new WireTestClient({ url: s.url, auth: s.surfaceJwt });
    try {
      await surface.connect();
      await surface.waitFor('auth.ok');
      const before = hostLink.sent.length;

      expect((await s.remove('host-b')).statusCode).toBe(200);

      expect(hostLink.forgotten).toEqual(['host-b']);
      expect(s.registry.managerHostId()).toBe('host-a');
      // The machine now running the Manager is told, so its own flag agrees.
      expect(
        hostLink.sent
          .slice(before)
          .filter((m) => m.event.type === 'host.set_manager')
          .map((m) => [m.hostId, (m.event as { hostId: string }).hostId]),
      ).toEqual([['host-a', 'host-a']]);
    } finally {
      await surface.close().catch(() => undefined);
      await s.built.app.close();
    }
  });
});

// The older route that can also revoke a machine. It closed EVERY machine's
// socket, not the one it revoked: `terminateHostSocket()` was wired with no
// id, which means "all of them".
describe('POST /api/auth/revoke of one machine', () => {
  it("closes only that machine's link", async () => {
    const s = await setup();
    const a = new WireTestClient({
      url: s.url,
      clientType: 'host',
      auth: await s.daemonKey('host-a'),
    });
    const b = new WireTestClient({
      url: s.url,
      clientType: 'host',
      auth: await s.daemonKey('host-b'),
    });
    try {
      await a.connect();
      await a.waitFor('auth.ok');
      await b.connect();
      await b.waitFor('auth.ok');
      let aClosed = false;
      a.onClose(() => {
        aClosed = true;
      });
      const bClosed = new Promise<void>((resolve) => b.onClose(() => resolve()));

      const res = await s.built.app.inject({
        method: 'POST',
        url: '/api/auth/revoke',
        headers: { authorization: `Bearer ${s.surfaceJwt}` },
        payload: { id: 'host-b' },
      });
      expect(res.statusCode).toBe(200);
      await bClosed;
      await new Promise((r) => setTimeout(r, 100));
      expect(aClosed).toBe(false);
    } finally {
      await a.close().catch(() => undefined);
      await b.close().catch(() => undefined);
      await s.built.app.close();
    }
  });
});
