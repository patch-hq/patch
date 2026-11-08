import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

describe('/api/issue-reporting and /api/issue-reports', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-issue-routes-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function boot(logger: object | false = false) {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(15));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 'srf-ir', surfaceKind: 'web', label: 'web', issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-ir',
      surfaceKind: 'web',
      label: 'web',
    });
    const built = await buildAll({
      dataDir: dir,
      registry,
      hostLink: new InProcessHostLink(),
      jobsWatch: false,
      logger,
    });
    return { built, app: built.app, auth: { authorization: `Bearer ${jwt}` } };
  }

  it('requires a surface credential', async () => {
    const { app } = await boot();
    expect((await app.inject({ method: 'GET', url: '/api/issue-reporting' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/api/issue-reports', payload: {} })).statusCode,
    ).toBe(401);
  });

  it('is off by default, can be turned on, and says there is no token', async () => {
    const { app, auth } = await boot();
    const off = await app.inject({ method: 'GET', url: '/api/issue-reporting', headers: auth });
    expect(off.json()).toMatchObject({ enabled: false, pending: 0 });
    const on = await app.inject({
      method: 'PUT',
      url: '/api/issue-reporting',
      headers: auth,
      payload: { enabled: true },
    });
    expect(on.json()).toMatchObject({ enabled: true });
  });

  it('rejects a malformed report and fails loudly when it cannot be filed', async () => {
    const { app, auth } = await boot();
    const bad = await app.inject({
      method: 'POST',
      url: '/api/issue-reports',
      headers: auth,
      payload: { title: '' },
    });
    expect(bad.statusCode).toBe(400);
    const noToken = await app.inject({
      method: 'POST',
      url: '/api/issue-reports',
      headers: auth,
      payload: { title: 'Broken', description: 'x' },
    });
    expect(noToken.statusCode).toBe(502);
    expect(noToken.json().error).toMatch(/token/);
  });

  it('queues every server error log line once reporting is on, and nothing before', async () => {
    const { built, app, auth } = await boot({ level: 'error' });
    app.log.error(new Error('before the switch'));
    expect(built.issueFiler.status().pending).toBe(0);
    await app.inject({
      method: 'PUT',
      url: '/api/issue-reporting',
      headers: auth,
      payload: { enabled: true },
    });
    app.log.error({ err: new Error('db exploded at /home/tom/x') }, 'request failed');
    const status = built.issueFiler.status();
    expect(status.pending).toBe(1);
  });
});
