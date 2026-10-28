// Manager placement through the real hub: the host running the Manager goes
// away, another host is asked to run it for good, and a surface opening the
// Manager afterwards still sees what the new host's own log is missing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { WireTestClient } from '@patch/wire/test-client';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

const wait = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('Manager failover through the hub', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-mfhub-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('asks another host to run the Manager, and still answers a replay across the gap', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(41));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.setDaemonKey({ hostId: 'home', publicKey: user.publicKey, issuedAt: 1 });
    registry.setDaemonKey({ hostId: 'other', publicKey: user.publicKey, issuedAt: 1 });
    const link = new InProcessHostLink();
    link.setHostId(null);
    link.addOnlineHost('home');
    link.addOnlineHost('other');
    const built = await buildAll({
      logger: false,
      registry,
      hostLink: link,
      managerFailoverGraceMs: 40,
    });
    await built.app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const say = (from: string, seq: number, role: 'user' | 'assistant', content: string) =>
        link.emit({ type: 'chat.message', chatId: 'thread_manager', role, content, seq }, from);
      link.emit(
        { type: 'chat.spawned', chatId: 'thread_manager', hostId: 'home', folder: '/m' },
        'home',
      );
      say('home', 0, 'user', 'before');
      say('home', 1, 'assistant', 'noted');

      link.dropOnlineHost('home');
      await wait();
      const adopt = link.sent.find((s) => s.event.type === 'host.manager_adopt');
      expect(adopt?.hostId).toBe('other');
      expect(adopt?.event).toMatchObject({ nextSeq: 2 });
      expect((adopt!.event as { handoff: string }).handoff).toContain('user: before');

      say('other', 2, 'user', 'while away');
      say('other', 3, 'assistant', 'covered');
      link.addOnlineHost('home');
      await wait();
      expect(link.sent.some((s) => s.event.type === 'host.manager_release')).toBe(true);

      // A surface opens the Manager. The new host answers from its own log; the
      // server adds the stretch that log is missing (what 'home' ran).
      registry.upsertSurface({ surfaceId: 'srf-1', surfaceKind: 'web', label: 'b', issuedAt: 1 });
      const jwt = await mintSurfaceCredential({
        userPrivateKey: user.privateKey,
        surfaceId: 'srf-1',
        surfaceKind: 'web',
        label: 'b',
      });
      const url = `ws://127.0.0.1:${(built.app.server.address() as AddressInfo).port}/ws`;
      const client = new WireTestClient({ url, auth: jwt });
      await client.connect();
      await client.waitFor('host.online');
      const got: number[] = [];
      client.on('chat.message', (e) => got.push(e.seq));
      client.replay('thread_manager', -1);
      await wait();
      expect(got).toEqual([0, 1]);
      await client.close();
    } finally {
      await built.app.close();
    }
  });

  it('runs the sweep on the Manager host, and on the new one once it has taken over', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(42));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.setDaemonKey({ hostId: 'home', publicKey: user.publicKey, issuedAt: 1 });
    registry.setDaemonKey({ hostId: 'other', publicKey: user.publicKey, issuedAt: 1 });
    // The sweep is off until switched on.
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ sweepEnabled: true }));
    const link = new InProcessHostLink();
    link.setHostId(null);
    link.addOnlineHost('home');
    link.addOnlineHost('other');
    const built = await buildAll({
      logger: false,
      registry,
      hostLink: link,
      managerFailoverGraceMs: 40,
    });
    try {
      const settle = (chatId: string): void => {
        link.emit(
          { type: 'chat.spawned', chatId, hostId: 'home', folder: '/w' } as WireEvent,
          'home',
        );
        for (const activity of ['running', 'idle']) {
          link.emit(
            {
              type: 'chat.state',
              chatId,
              hostId: 'home',
              activity,
              permissionMode: 'auto',
              folder: '/w',
              lastUpdated: 1,
            } as WireEvent,
            'home',
          );
        }
      };
      const sweepTargets = (): string[] =>
        link.sent.filter((s) => s.event.type === 'manager.sweep_run').map((s) => s.hostId);

      settle('chat-a');
      expect(built.managerSweeper.checkNow()).toBe(true);
      expect(sweepTargets()).toEqual(['home']);
      built.managerSweeper.onResult({
        runId: (link.sent.at(-1)!.event as { runId: string }).runId,
        actions: [],
        tokensUsed: 0,
      });

      link.dropOnlineHost('home');
      await wait();
      settle('chat-b');
      expect(built.managerSweeper.checkNow()).toBe(true);
      expect(sweepTargets()).toEqual(['home', 'other']);
    } finally {
      await built.app.close();
    }
  });
});
