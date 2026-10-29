// GET /api/hosts — the host registry (spec/01 § Endpoints).
//
// The endpoint was listed in the spec and did not exist at all: the server
// answered `route not found`, so nothing could enumerate the account's machines
// over REST, and a host had no way to answer `patch_list_hosts` for its chats.
//
// It is authed by a daemonKey AS WELL AS a surface credential precisely because
// the host is a legitimate caller with no surface credential to present.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential, mintDaemonKey } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

describe('POST /api/hosts/auto-update', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-hosts-au-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function boot() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(7));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-au',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    registry.setDaemonKey({ hostId: 'host-a', publicKey: user.publicKey, issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-au',
      surfaceKind: 'web',
      label: 'browser',
    });
    const built = await buildAll({
      dataDir: dir,
      registry,
      hostLink: new InProcessHostLink(),
      jobsWatch: false,
    });
    const post = (payload: unknown, auth = true) =>
      built.app.inject({
        method: 'POST',
        url: '/api/hosts/auto-update',
        payload: payload as object,
        headers: auth ? { authorization: `Bearer ${jwt}` } : {},
      });
    return { app: built.app, registry, post };
  }

  it('stores the override, persists it, and reports it on the host list', async () => {
    const { app, registry, post } = await boot();
    try {
      const until = Date.now() + 3_600_000;
      const res = await post({ hostId: 'host-a', override: { enabled: false, until } });
      expect(res.statusCode).toBe(200);
      expect(registry.autoUpdateOverride('host-a')).toEqual({ enabled: false, until });
      expect(Registry.load(dir).autoUpdateOverride('host-a')).toEqual({ enabled: false, until });
    } finally {
      await app.close();
    }
  });

  it('clears the override with null', async () => {
    const { app, registry, post } = await boot();
    try {
      await post({ hostId: 'host-a', override: { enabled: false } });
      expect((await post({ hostId: 'host-a', override: null })).statusCode).toBe(200);
      expect(registry.autoUpdateOverride('host-a')).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('refuses a pause that has already lapsed, an unknown machine, bad input and no credential', async () => {
    const { app, registry, post } = await boot();
    try {
      const past = await post({ hostId: 'host-a', override: { enabled: false, until: 5 } });
      expect(past.statusCode).toBe(400);
      expect((await post({ hostId: 'nope', override: null })).statusCode).toBe(404);
      expect((await post({ hostId: 'host-a', override: { enabled: 'x' } })).statusCode).toBe(400);
      expect((await post({ hostId: 'host-a', override: null }, false)).statusCode).toBe(401);
      expect(registry.autoUpdateOverride('host-a')).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
