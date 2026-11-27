// spec/10 § Local credentials: something on the server's own machine gets a
// surface credential by presenting the data folder's local-admin secret, with
// no other device asked to approve it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';
import { LOCAL_ADMIN_HEADER, LOCAL_ADMIN_TOKEN_FILE } from '../src/local-admin.js';

describe('POST /api/auth/local/credential', () => {
  let dir: string;
  let close: (() => Promise<unknown>) | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-local-cred-'));
  });
  afterEach(async () => {
    await close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  async function makeApp() {
    const registry = Registry.load(dir);
    if (!registry.getAccount())
      registry.bootstrapAccount({ keypair: generateUserKeypair(() => new Uint8Array(32).fill(7)) });
    const built = await buildAll({
      logger: false,
      registry,
      dataDir: dir,
      hostLink: new InProcessHostLink(),
      jobsWatch: false,
      gcalSubscriptions: false,
    });
    close = () => built.app.close();
    const secret = readFileSync(join(dir, LOCAL_ADMIN_TOKEN_FILE), 'utf8').trim();
    const issue = (label: string, token: string | null = secret) =>
      built.app.inject({
        method: 'POST',
        url: '/api/auth/local/credential',
        headers: token === null ? {} : { [LOCAL_ADMIN_HEADER]: token },
        payload: { label },
      });
    return { built, registry, issue, secret };
  }

  it('writes the secret owner-only and issues a working credential for it', async () => {
    const { built, issue } = await makeApp();
    expect(statSync(join(dir, LOCAL_ADMIN_TOKEN_FILE)).mode & 0o777).toBe(0o600);
    const res = await issue('Agent checks');
    expect(res.statusCode).toBe(200);
    const { credential, surfaceId } = res.json() as { credential: string; surfaceId: string };
    expect(surfaceId).toBe('local-agent-checks');
    const me = await built.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { surface: { label: string } }).surface.label).toBe('Agent checks');
  });

  it('refuses without the secret, or with a wrong one', async () => {
    const { issue, secret } = await makeApp();
    expect((await issue('x', null)).statusCode).toBe(401);
    expect(
      (
        await issue(
          'x',
          secret.replace(/.$/, (c) => (c === '0' ? '1' : '0')),
        )
      ).statusCode,
    ).toBe(401);
  });

  it('renews one device per label rather than adding another', async () => {
    const { registry, issue } = await makeApp();
    await issue('Agent checks');
    await issue('agent  checks');
    expect(
      registry.listSurfaces().filter((s) => s.surfaceId === 'local-agent-checks'),
    ).toHaveLength(1);
  });

  it('keeps a removed device removed', async () => {
    const { registry, issue } = await makeApp();
    await issue('Agent checks');
    registry.revoke('local-agent-checks');
    const again = await issue('Agent checks');
    expect(again.statusCode).toBe(409);
    expect(registry.isRevoked('local-agent-checks')).toBe(true);
  });

  it('keeps the same secret across restarts', async () => {
    const { secret } = await makeApp();
    await close?.();
    const second = await makeApp();
    expect(second.secret).toBe(secret);
  });
});
