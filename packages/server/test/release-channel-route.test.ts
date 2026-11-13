// PUT /api/release-channel — a user picks stable (default) or dev from Settings;
// `off` stays the operator's choice and is never overwritten from a client.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

describe('/api/release-channel', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-relchan-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function boot() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(15));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 'srf-rc', surfaceKind: 'web', label: 'web', issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-rc',
      surfaceKind: 'web',
      label: 'web',
    });
    const built = await buildAll({
      dataDir: dir,
      registry,
      hostLink: new InProcessHostLink(),
      jobsWatch: false,
    });
    return { app: built.app, auth: { authorization: `Bearer ${jwt}` } };
  }

  it('reports stable by default and switches to dev and back', async () => {
    const { app, auth } = await boot();
    const before = await app.inject({ method: 'GET', url: '/api/version', headers: auth });
    expect(before.json().release.channel).toBe('stable');

    const dev = await app.inject({
      method: 'PUT',
      url: '/api/release-channel',
      headers: auth,
      payload: { channel: 'dev' },
    });
    expect(dev.statusCode).toBe(200);
    expect(readFileSync(join(dir, 'release-channel'), 'utf8').trim()).toBe('dev');
    const after = await app.inject({ method: 'GET', url: '/api/version', headers: auth });
    expect(after.json().release.channel).toBe('dev');

    await app.inject({
      method: 'PUT',
      url: '/api/release-channel',
      headers: auth,
      payload: { channel: 'stable' },
    });
    expect(readFileSync(join(dir, 'release-channel'), 'utf8').trim()).toBe('stable');
  });

  it('rejects unauthenticated, invalid and off-overriding requests', async () => {
    const { app, auth } = await boot();
    const anon = await app.inject({
      method: 'PUT',
      url: '/api/release-channel',
      payload: { channel: 'dev' },
    });
    expect(anon.statusCode).toBe(401);
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/release-channel',
      headers: auth,
      payload: { channel: 'off' },
    });
    expect(bad.statusCode).toBe(400);
    writeFileSync(join(dir, 'release-channel'), 'off\n');
    const blocked = await app.inject({
      method: 'PUT',
      url: '/api/release-channel',
      headers: auth,
      payload: { channel: 'dev' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(readFileSync(join(dir, 'release-channel'), 'utf8').trim()).toBe('off');
  });
});
