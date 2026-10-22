// A host lists and reorders the shared accounts over the link it already holds
// (`patch.accounts.request`), and the answer goes back to the asking machine.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

type Res = Extract<WireEvent, { type: 'patch.accounts.response' }>;
let n = 0;

describe('accounts rpc bridge', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-accounts-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function makeApp() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(9));
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
    const hostLink = new InProcessHostLink();
    const built = await buildAll({
      logger: false,
      registry,
      dataDir: data,
      hostLink,
      validateClaudeToken: async (t: string) => ({ kind: 'valid', organizationId: `org-${t}` }),
      jobsWatch: false,
      gcalSubscriptions: false,
    });
    const addAccount = async (token: string, label: string): Promise<string> => {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/accounts/claude-code',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { token, label },
      });
      expect(res.statusCode, res.body).toBe(200);
      const claude = (res.json() as { secrets: { claude: Array<{ id: string; label: string }> } })
        .secrets.claude;
      return claude.find((c) => c.label === label)!.id;
    };
    const ask = async (req: Record<string, unknown>): Promise<Res> => {
      const requestId = `r${++n}`;
      hostLink.emit({ type: 'patch.accounts.request', requestId, ...req } as WireEvent, 'host-1');
      for (let i = 0; i < 300; i++) {
        const hit = hostLink.sent.find(
          (s) => s.event.type === 'patch.accounts.response' && s.event.requestId === requestId,
        );
        if (hit) {
          expect(hit.hostId).toBe('host-1'); // back to the machine that asked
          return hit.event as Res;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('no patch.accounts.response');
    };
    return { built, ask, addAccount };
  }

  it('lists, reorders and sets the strategy; refuses a bad order with the service code', async () => {
    const { built, ask, addAccount } = await makeApp();
    try {
      const a = await addAccount('tok-a', 'Work');
      const b = await addAccount('tok-b', 'Personal');

      const listed = await ask({ op: 'list' });
      expect(listed.ok).toBe(true);
      expect(
        (listed.result as { claude: Array<{ label: string }> }).claude.map((x) => x.label),
      ).toEqual(['Work', 'Personal']);

      const reordered = await ask({ op: 'order', backendId: 'claude-code', accountIds: [b, a] });
      expect(reordered.ok, JSON.stringify(reordered.error)).toBe(true);
      expect(
        (reordered.result as { claude: Array<{ label: string }> }).claude.map((x) => x.label),
      ).toEqual(['Personal', 'Work']);

      const strat = await ask({
        op: 'strategy',
        backendId: 'claude-code',
        strategy: 'round-robin',
      });
      expect((strat.result as { strategy: { claude: string } }).strategy.claude).toBe(
        'round-robin',
      );

      const bad = await ask({ op: 'order', backendId: 'claude-code', accountIds: [a] });
      expect(bad.ok).toBe(false);
      expect(bad.error?.code).toBe('invalid_order');
    } finally {
      await built.app.close();
    }
  });
});
