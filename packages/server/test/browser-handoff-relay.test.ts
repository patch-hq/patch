// Agent browser live view and hand-off (spec/02 § Browser — Hand-off): the
// hub forwards what the user does in the live view to the host, and fans the
// host's frames and hand-off prompt out only to a surface watching the chat.
// A frame is a picture of a page the user may be signing in to, so a surface
// that never focused the chat must never get one.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { WireTestClient } from '@patch/wire/test-client';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

describe('browser hand-off through the hub', () => {
  it('relays input, control and watch to the host, and shows frames and prompts only to a watcher', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-handoff-hub-'));
    try {
      const user = generateUserKeypair(() => new Uint8Array(32).fill(12));
      const registry = Registry.load(dir);
      registry.bootstrapAccount({ keypair: user });
      for (const id of ['srf-watch', 'srf-idle']) {
        registry.upsertSurface({ surfaceId: id, surfaceKind: 'web', label: id, issuedAt: 1 });
      }
      const hostLink = new InProcessHostLink();
      const built = await buildAll({ logger: false, registry, hostLink });
      await built.app.listen({ port: 0, host: '127.0.0.1' });
      const addr = built.app.server.address() as AddressInfo;
      hostLink.emit({ type: 'chat.spawned', hostId: 'd1', chatId: 'c1', folder: '/tmp/chat' });

      const connect = async (surfaceId: string): Promise<WireTestClient> => {
        const jwt = await mintSurfaceCredential({
          userPrivateKey: user.privateKey,
          surfaceId,
          surfaceKind: 'web',
          label: surfaceId,
        });
        const c = new WireTestClient({ url: `ws://127.0.0.1:${addr.port}/ws`, auth: jwt });
        const online = c.waitFor('host.online');
        await c.connect();
        await online;
        return c;
      };
      const watching = await connect('srf-watch');
      const idle = await connect('srf-idle');
      try {
        watching.send({ type: 'chat.focus_change', chatId: 'c1' });
        await new Promise((r) => setTimeout(r, 50));

        const idleGot: WireEvent[] = [];
        idle.on('patch.browser_view.frame', (e) => idleGot.push(e));
        idle.on('patch.browser_handoff.state', (e) => idleGot.push(e));
        idle.on('patch.browser_view.status', (e) => idleGot.push(e));

        const frame: WireEvent = {
          type: 'patch.browser_view.frame',
          chatId: 'c1',
          tabId: 't1',
          data: 'AAAA',
          width: 10,
          height: 10,
          url: 'https://example.com/',
          title: 'x',
        };
        const state: WireEvent = {
          type: 'patch.browser_handoff.state',
          chatId: 'c1',
          handoffId: 'h1',
          tabId: 't1',
          status: 'waiting',
          reason: 'Sign in',
          startedAt: 1,
        };
        const status: WireEvent = {
          type: 'patch.browser_view.status',
          chatId: 'c1',
          active: true,
          action: 'Clicking',
          tabs: [{ tabId: 't1', url: 'https://example.com/', handedOff: false }],
        };
        const gotStatus = watching.waitFor('patch.browser_view.status');
        const gotFrame = watching.waitFor('patch.browser_view.frame');
        const gotState = watching.waitFor('patch.browser_handoff.state');
        hostLink.emit(status);
        hostLink.emit(frame);
        hostLink.emit(state);
        expect(await gotStatus).toEqual(status);
        expect(await gotFrame).toEqual(frame);
        expect(await gotState).toEqual(state);
        await new Promise((r) => setTimeout(r, 50));
        expect(idleGot).toEqual([]);

        const toHost: WireEvent[] = [
          { type: 'patch.browser_view.watch', chatId: 'c1', watch: true },
          { type: 'patch.browser_view.stop', chatId: 'c1' },
          {
            type: 'patch.browser_handoff.input',
            chatId: 'c1',
            handoffId: 'h1',
            input: { kind: 'text', text: 'hunter2' },
          },
          { type: 'patch.browser_handoff.control', chatId: 'c1', handoffId: 'h1', action: 'done' },
        ];
        for (const e of toHost) watching.send(e);
        const browserSent = (): WireEvent[] =>
          hostLink.sent.map((s) => s.event).filter((e) => e.type.startsWith('patch.browser_'));
        for (let i = 0; i < 100 && browserSent().length < 4; i++) {
          await new Promise((r) => setTimeout(r, 20));
        }
        expect(browserSent()).toEqual(toHost);
      } finally {
        await watching.close();
        await idle.close();
      }
      await built.app.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
