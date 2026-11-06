// Every surface→host `host.*` frame actually reaches the host
// (spec/03 § Host events).
//
// A frame relayed to a host needs FOUR things: a wire type, a UI sender, a
// host handler, and a `case` in the hub's relay list. Three of those four are
// no use, and the fourth is the one that gets forgotten — it lives in a
// different package from the other three.
//
// When it is missing the frame does not merely go nowhere: it falls to the hub's
// `default:`, which warns "disallowed type" and CLOSES the surface's socket. The
// UI's pending state then has nothing to resolve it, so the action appears to do
// nothing at all and nothing says why. That is how `host.backend_add_account`
// shipped: Settings → Add another account sent the frame, the host knew how to
// handle it, and the server dropped it — along with `host.claude_settings_set`
// and `host.claude_memory_delete`, which were broken the same way and had not
// been noticed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { WireTestClient } from '@patch/wire/test-client';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

/**
 * One representative frame per surface→host `host.*` type the host owns.
 * A new one belongs here as well as in the hub — that is the point of the file.
 */
const HOST_FRAMES: { type: string; frame: Record<string, unknown> }[] = [
  { type: 'host.settings', frame: { hostId: 'd1', harnessMcpServers: [] } },
  { type: 'host.folder_add', frame: { hostId: 'd1', path: '/srv/work' } },
  { type: 'host.folder_remove', frame: { hostId: 'd1', path: '/srv/work' } },
  { type: 'host.update', frame: { hostId: 'd1' } },
  { type: 'host.component_install', frame: { hostId: 'd1', componentId: 'kokoro' } },
  { type: 'host.component_remove', frame: { hostId: 'd1', componentId: 'kokoro' } },
  // The three that were missing.
  {
    type: 'host.backend_add_account',
    frame: { hostId: 'd1', backendId: 'codex', authMethod: 'device', requestId: 'openai-login' },
  },
  { type: 'host.claude_settings_set', frame: { hostId: 'd1', text: '{}' } },
  {
    type: 'host.claude_memory_delete',
    frame: { hostId: 'd1', project: 'proj', file: 'entry.md' },
  },
  // Settings redesign.
  {
    type: 'host.claude_memory_set',
    frame: { hostId: 'd1', project: 'proj', file: 'entry.md', body: 'text' },
  },
];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patch-wshub-hostrelay-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('WS hub — surface→host frames are relayed, not dropped', () => {
  it('forwards every one of them to the host they name', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(77));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.setDaemonKey({ hostId: 'd1', publicKey: 'pk-d1', issuedAt: 1 });
    const hostLink = new InProcessHostLink();
    const built = await buildAll({
      logger: false as never,
      registry,
      hostLink,
    });
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = built.app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    registry.upsertSurface({
      surfaceId: 'srf-relay',
      surfaceKind: 'web',
      label: 'browser',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-relay',
      surfaceKind: 'web',
      label: 'browser',
    });
    const client = new WireTestClient({ url: `ws://127.0.0.1:${port}/ws`, auth: jwt });
    try {
      await client.connect();
      await client.waitFor('host.online');

      const before = hostLink.sent.length;
      for (const { type, frame } of HOST_FRAMES) {
        client.send({ type, ...frame } as never);
      }
      // The socket staying OPEN is half the assertion: a disallowed type closes
      // it, so a dropped frame would take every later one down with it.
      await new Promise((r) => setTimeout(r, 300));

      const relayed = hostLink.sent.slice(before).map((s) => s.event.type);
      for (const { type } of HOST_FRAMES) {
        expect(relayed, `${type} must reach the host`).toContain(type);
      }
    } finally {
      await client.close().catch(() => undefined);
      await built.app.close();
    }
  });
});
