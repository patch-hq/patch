// POST/GET /api/client-crashes — phone crash reports stored where the server
// can read them back.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

describe('/api/client-crashes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-client-crash-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function boot() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(14));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-cc',
      surfaceKind: 'mobile',
      label: 'phone',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-cc',
      surfaceKind: 'mobile',
      label: 'phone',
    });
    const built = await buildAll({
      dataDir: dir,
      registry,
      hostLink: new InProcessHostLink(),
      jobsWatch: false,
    });
    return { app: built.app, auth: { authorization: `Bearer ${jwt}` } };
  }

  const report = {
    source: 'boundary',
    message: 'undefined is not an object',
    stack: 'at Foo (bundle.js:1:2)',
    chatId: 'chat-1',
    occurredAt: 1_700_000_000_000,
  };

  it('stores a report to disk and returns it from GET', async () => {
    const { app, auth } = await boot();
    const post = await app.inject({
      method: 'POST',
      url: '/api/client-crashes',
      headers: auth,
      payload: report,
    });
    expect(post.statusCode).toBe(200);
    const line = readFileSync(join(dir, 'client-crashes.jsonl'), 'utf8').trim();
    expect(JSON.parse(line)).toMatchObject({ ...report, surfaceId: 'srf-cc' });

    const get = await app.inject({ method: 'GET', url: '/api/client-crashes', headers: auth });
    expect(get.json().crashes).toHaveLength(1);
    expect(get.json().crashes[0].chatId).toBe('chat-1');
  });

  it('rejects unauthenticated and malformed reports', async () => {
    const { app, auth } = await boot();
    const anon = await app.inject({ method: 'POST', url: '/api/client-crashes', payload: report });
    expect(anon.statusCode).toBe(401);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/client-crashes',
      headers: auth,
      payload: { source: 'nope' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('skips a truncated line in the store instead of failing the whole GET', async () => {
    const { app, auth } = await boot();
    await app.inject({
      method: 'POST',
      url: '/api/client-crashes',
      headers: auth,
      payload: report,
    });
    appendFileSync(join(dir, 'client-crashes.jsonl'), '{"source":"boundary","mess');
    const get = await app.inject({ method: 'GET', url: '/api/client-crashes', headers: auth });
    expect(get.statusCode).toBe(200);
    expect(get.json().crashes).toHaveLength(1);
  });
});
