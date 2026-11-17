// A restart is bounded (spec/12 § Server restarts): closing the server never
// waits on a request still open, and a socket that ignores the going-away
// notice is cut after a moment.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { build } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

describe('server shutdown', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-shutdown-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('does not wait for a request that never finishes', async () => {
    const app = await build({ registry: Registry.load(dir), hostLink: new InProcessHostLink() });
    app.get('/test/hang', () => new Promise(() => {}));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const req = http.get(`http://127.0.0.1:${port}/test/hang`);
    req.on('error', () => {});
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
