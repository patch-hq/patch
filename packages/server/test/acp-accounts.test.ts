// ACP agents' accounts (spec/10 § Backend credentials, § Signing in): an API
// key the server validates, stores encrypted and hands to every host in the
// snapshot. A surface only ever sees its label, last four and state.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { EMPTY_SHARED_SECRETS, type WireEvent } from '@patch/wire';
import { SharedSettingsService } from '../src/shared-settings.js';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

const KEY_A = 'AIzaFakeGeminiKeyForTestsAAAA1111';
const KEY_B = 'AIzaFakeGeminiKeyForTestsBBBB2222';

function everythingOnDisk(dir: string): string {
  let out = '';
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    out += statSync(p).isDirectory() ? everythingOnDisk(p) : readFileSync(p, 'utf8');
  }
  return out;
}

describe('ACP accounts in the shared settings', () => {
  let dir: string;
  let sent: Array<{ hostId: string; event: WireEvent }>;
  let status: number | 'down';
  let checked: Array<{ url: string; key: string | undefined }>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-acp-accounts-'));
    sent = [];
    status = 200;
    checked = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const make = (online: string[] = []): SharedSettingsService => {
    const svc: SharedSettingsService = new SharedSettingsService({
      dataDir: dir,
      sendToHost: (hostId, event) => {
        sent.push({ hostId, event });
        // An online host answers its one-time import at once, holding nothing.
        if (event.type === 'settings.adopt.request' && event.kind === 'import') {
          queueMicrotask(() =>
            svc.handleHostEvent({
              type: 'settings.adopt.response',
              requestId: event.requestId,
              hostId,
              ok: true,
              result: { kind: 'import', import: { settings: {}, secrets: EMPTY_SHARED_SECRETS } },
            }),
          );
        }
      },
      onlineHostIds: () => online,
      broadcast: () => undefined,
      keyCheckFetch: async (url, init) => {
        checked.push({
          url,
          key: (init.headers as Record<string, string>)['x-goog-api-key'],
        });
        if (status === 'down') throw new Error('offline');
        return new Response('{}', { status });
      },
    });
    return svc;
  };

  it('signs Gemini CLI in with a key the provider accepts, and never shows the key', async () => {
    const svc = make();
    const account = await svc.addAcpAccount('gemini', `  ${KEY_A} `);
    expect(account).toMatchObject({ agentId: 'gemini', label: 'Gemini CLI', apiKey: KEY_A });
    // Validated with the agent's free, read-only check before it was stored.
    expect(checked).toEqual([{ url: expect.stringContaining('generativelanguage'), key: KEY_A }]);
    expect(svc.secretsSummary().acp).toEqual([
      {
        id: account.id,
        agentId: 'gemini',
        label: 'Gemini CLI',
        last4: '1111',
        state: { state: 'ready' },
      },
    ]);
    expect(JSON.stringify(svc.changedEvent())).not.toContain(KEY_A);
    // Encrypted at rest.
    expect(everythingOnDisk(dir)).not.toContain(KEY_A);
    // A second account is named apart from the first.
    expect((await svc.addAcpAccount('gemini', KEY_B)).label).toBe('Gemini CLI 2');
  });

  it('stores nothing for a key the provider refuses or could not check', async () => {
    const svc = make();
    status = 400;
    await expect(svc.addAcpAccount('gemini', KEY_A)).rejects.toMatchObject({
      status: 400,
      code: 'credential_rejected',
    });
    status = 'down';
    await expect(svc.addAcpAccount('gemini', KEY_A)).rejects.toMatchObject({
      status: 502,
      code: 'credential_unreachable',
    });
    expect(svc.secretsSummary().acp).toBeUndefined();
  });

  it('refuses a malformed key, a duplicate, an unknown agent and one that takes no key', async () => {
    const svc = make();
    await expect(svc.addAcpAccount('gemini', 'short')).rejects.toMatchObject({
      code: 'invalid_value',
    });
    await svc.addAcpAccount('gemini', KEY_A, 'Work');
    await expect(svc.addAcpAccount('gemini', KEY_A)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('Work'),
    });
    await expect(svc.addAcpAccount('nope', KEY_B)).rejects.toMatchObject({ status: 404 });
    svc.update({
      acpAgents: [{ id: 'local', label: 'Local agent', command: 'local-agent', args: [] }],
    });
    await expect(svc.addAcpAccount('local', KEY_B)).rejects.toMatchObject({
      code: 'no_api_key',
    });
  });

  it('stores a key unchecked for an agent that names no check', async () => {
    const svc = make();
    svc.update({
      acpAgents: [
        { id: 'other', label: 'Other', command: 'other', args: [], apiKeyEnv: 'OTHER_KEY' },
      ],
    });
    await svc.addAcpAccount('other', KEY_B);
    expect(checked).toEqual([]);
    expect(svc.secretsSummary().acp?.map((a) => a.agentId)).toEqual(['other']);
  });

  it('hands every host the key in its snapshot; signing in again keeps the row', async () => {
    const svc = make(['d1']);
    svc.hostOnline('d1');
    await new Promise((r) => setTimeout(r, 10));
    const account = await svc.addAcpAccount('gemini', KEY_A, 'Work');
    const snapshots = () =>
      sent
        .map((s) => s.event)
        .filter(
          (e): e is Extract<WireEvent, { type: 'settings.snapshot' }> =>
            e.type === 'settings.snapshot',
        );
    expect(snapshots().at(-1)?.secrets.acp).toEqual([
      { id: account.id, agentId: 'gemini', label: 'Work', apiKey: KEY_A },
    ]);
    await svc.replaceAcpKey('gemini', account.id, KEY_B);
    expect(snapshots().at(-1)?.secrets.acp).toEqual([
      { id: account.id, agentId: 'gemini', label: 'Work', apiKey: KEY_B },
    ]);
    // Removing the last one leaves the field absent, as an older host expects.
    svc.removeAcpAccount('gemini', account.id);
    expect(snapshots().at(-1)?.secrets).not.toHaveProperty('acp');
    expect(() => svc.removeAcpAccount('gemini', account.id)).toThrow(/No gemini account/);
  });

  it('keeps the accounts across a restart', async () => {
    const svc = make();
    await svc.addAcpAccount('gemini', KEY_A);
    expect(
      make()
        .secretsSummary()
        .acp?.map((a) => a.last4),
    ).toEqual(['1111']);
  });
});

describe('ACP account routes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-acp-routes-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function boot() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(46));
    const data = mkdtempSync(join(dir, 'data-'));
    const registry = Registry.load(data);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 'srf-web', surfaceKind: 'web', label: 'web', issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-web',
      surfaceKind: 'web',
      label: 'web',
    });
    const link = new InProcessHostLink();
    link.setHostId(null);
    const built = await buildAll({
      logger: false,
      registry,
      dataDir: data,
      hostLink: link,
      keyCheckFetch: async () => new Response('{}', { status: 200 }),
      jobsWatch: false,
      gcalSubscriptions: false,
    });
    return { built, auth: { authorization: `Bearer ${jwt}` } };
  }

  it('adds, re-keys and removes an account, answering with the summary only', async () => {
    const { built, auth } = await boot();
    try {
      const unauth = await built.app.inject({
        method: 'POST',
        url: '/api/accounts/acp/gemini',
        payload: { apiKey: KEY_A },
      });
      expect(unauth.statusCode).toBe(401);

      const added = await built.app.inject({
        method: 'POST',
        url: '/api/accounts/acp/gemini',
        headers: auth,
        payload: { apiKey: KEY_A, label: 'Work' },
      });
      expect(added.statusCode).toBe(200);
      expect(added.body).not.toContain(KEY_A);
      const acp = (added.json() as { secrets: { acp: Array<{ id: string; label: string }> } })
        .secrets.acp;
      expect(acp).toHaveLength(1);
      const id = acp[0]!.id;

      const rekeyed = await built.app.inject({
        method: 'PUT',
        url: `/api/accounts/acp/gemini/${id}/key`,
        headers: auth,
        payload: { apiKey: KEY_B },
      });
      expect(rekeyed.statusCode).toBe(200);
      expect(rekeyed.body).toContain('2222');

      const unknown = await built.app.inject({
        method: 'POST',
        url: '/api/accounts/acp/nope',
        headers: auth,
        payload: { apiKey: KEY_A },
      });
      expect(unknown.statusCode).toBe(404);

      const removed = await built.app.inject({
        method: 'DELETE',
        url: `/api/accounts/acp/gemini/${id}`,
        headers: auth,
      });
      expect(removed.statusCode).toBe(200);
      expect((removed.json() as { secrets: { acp?: unknown } }).secrets.acp).toBeUndefined();
    } finally {
      await built.app.close();
    }
  });
});
