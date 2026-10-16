import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InProcessHostLink } from '../src/host-link.js';
import { build } from '../src/app.js';
import { Registry } from '../src/registry.js';

describe('host rename: REST inbound accepts the legacy daemonId', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-rest-rename-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('rewrites daemonId in a JSON body and in the query before the route sees it', async () => {
    const registry = Registry.load(dir);
    const app = await build({ logger: false, registry, hostLink: new InProcessHostLink() });
    const seen: { body: unknown; query: unknown }[] = [];
    app.post('/__test/echo', async (req) => {
      seen.push({ body: req.body, query: req.query });
      return {};
    });
    try {
      await app.inject({
        method: 'POST',
        url: '/__test/echo?daemonId=h2',
        payload: { daemonId: 'h1', nested: [{ daemonId: 'h3' }] },
      });
      expect(seen).toEqual([
        { body: { hostId: 'h1', nested: [{ hostId: 'h3' }] }, query: { hostId: 'h2' } },
      ]);
    } finally {
      await app.close();
    }
  });
});
