// A host's CLI manages patch through `patch.api.request`: the server runs the
// call as the account, for management paths only, and answers the asking host.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';
import { isRelayablePath } from '../src/api-rpc-bridge.js';

type Res = Extract<WireEvent, { type: 'patch.api.response' }>;
let n = 0;

describe('isRelayablePath', () => {
  it('allows management paths and refuses the rest', () => {
    expect(isRelayablePath('/api/settings/shared')).toBe(true);
    expect(isRelayablePath('/api/accounts/claude-code/order')).toBe(true);
    expect(isRelayablePath('/api/hosts?x=1')).toBe(true);
    expect(isRelayablePath('/api/auth/pair/start')).toBe(false);
    expect(isRelayablePath('/api/settingsX')).toBe(false);
    expect(isRelayablePath('/api/settings/../auth')).toBe(false);
    expect(isRelayablePath('/internal/anything')).toBe(false);
  });
});

describe('api rpc bridge', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-api-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('runs an allowed call as the account and answers the asking host; refuses others', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(11));
    const data = mkdtempSync(join(dir, 'data-'));
    const registry = Registry.load(data);
    registry.bootstrapAccount({ keypair: user });
    const hostLink = new InProcessHostLink();
    const built = await buildAll({
      logger: false,
      registry,
      dataDir: data,
      hostLink,
      jobsWatch: false,
      gcalSubscriptions: false,
    });
    const ask = async (req: Record<string, unknown>): Promise<Res> => {
      const requestId = `r${++n}`;
      hostLink.emit({ type: 'patch.api.request', requestId, ...req } as WireEvent, 'host-1');
      for (let i = 0; i < 300; i++) {
        const hit = hostLink.sent.find(
          (s) => s.event.type === 'patch.api.response' && s.event.requestId === requestId,
        );
        if (hit) {
          expect(hit.hostId).toBe('host-1');
          return hit.event as Res;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('no patch.api.response');
    };
    try {
      const ok = await ask({ method: 'GET', path: '/api/settings/shared' });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ settings: expect.any(Object) });
      const no = await ask({ method: 'POST', path: '/api/auth/pair/start', body: {} });
      expect(no.status).toBe(403);
      expect(no.body).toMatchObject({ error: 'path_not_relayable' });
    } finally {
      await built.app.close();
    }
  });
});
