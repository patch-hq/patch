// PATCH /api/settings checks a new Manager folder on the Manager's home host
// before saving it (spec/06 § Manager prompt and folder) — the one route web,
// phone and `patch settings set manager-folder` all write through.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

type Req = Extract<WireEvent, { type: 'patch.host_files.request' }>;

/** A home host whose only folder is /srv/work. */
class FolderHost extends InProcessHostLink {
  readonly asked: Req[] = [];
  override sendTo(hostId: string, surfaceId: string, event: WireEvent): void {
    super.sendTo(hostId, surfaceId, event);
    if (event.type !== 'patch.host_files.request') return;
    this.asked.push(event);
    const base = { type: 'patch.host_files.response' as const, requestId: event.requestId, hostId };
    this.emit(
      event.path === '/srv/work'
        ? { ...base, ok: true, path: event.path, parent: '/srv', entries: [] }
        : { ...base, ok: false, error: { code: 'not_found', message: 'no such folder' } },
      hostId,
    );
  }
}

describe('PATCH /api/settings → managerFolder', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-mgr-folder-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function boot() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(44));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 'srf', surfaceKind: 'web', label: 'web', issuedAt: 1 });
    registry.setDaemonKey({ hostId: 'd1', publicKey: user.publicKey, issuedAt: 1 });
    registry.setHostName('d1', 'Studio Mac');
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf',
      surfaceKind: 'web',
      label: 'web',
    });
    const link = new FolderHost();
    const built = await buildAll({ logger: false, registry, hostLink: link, dataDir: dir });
    const patch = (managerFolder: string) =>
      built.app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { managerFolder },
      });
    return { built, link, patch };
  }

  it('saves a folder on the home host, refuses anything else naming the host, and leaves the default unchecked', async () => {
    const { built, link, patch } = await boot();
    try {
      const refused = await patch('/srv/nope');
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toEqual({
        error: 'manager_folder',
        message: '/srv/nope is not a folder on Studio Mac',
      });
      const saved = await patch('/srv/work');
      expect(saved.statusCode).toBe(200);
      expect(saved.json().preferences.managerFolder).toBe('/srv/work');
      expect(link.asked.map((r) => [r.hostId, r.path])).toEqual([
        ['d1', '/srv/nope'],
        ['d1', '/srv/work'],
      ]);
      const reset = await patch('');
      expect(reset.statusCode).toBe(200);
      expect(link.asked).toHaveLength(2);
    } finally {
      await built.app.close();
    }
  });
});
