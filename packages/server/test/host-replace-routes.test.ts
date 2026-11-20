// spec/11 § Replacing a host (decisions 4 and 12) — the server half: the new
// host checks the old host's folders, takes over every chat continuing from the
// server's high-water mark, the chats are rebound to it, held messages follow,
// and the old host is removed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { AdoptedChat, WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

/** A new host that has the folders it is told it has, and takes chats as told. */
class FakeHosts extends InProcessHostLink {
  present = new Set<string>();
  refuse = new Set<string>();
  silent = false;
  adopted: AdoptedChat[] = [];
  constructor() {
    super();
    this.addOnlineHost('d1');
    this.addOnlineHost('d2');
  }
  override sendTo(hostId: string, surfaceId: string, event: WireEvent): void {
    super.sendTo(hostId, surfaceId, event);
    if (this.silent) return;
    if (event.type === 'patch.folders_check.request') {
      const missing = event.folders.filter((f) => !this.present.has(f));
      queueMicrotask(() =>
        this.emit(
          { type: 'patch.folders_check.response', requestId: event.requestId, hostId, missing },
          hostId,
        ),
      );
    }
    if (event.type === 'patch.chat_adopt.request') {
      this.adopted.push(...event.chats);
      const refused = event.chats
        .filter((c) => this.refuse.has(c.chatId))
        .map((c) => ({ chatId: c.chatId, message: 'meta.json could not be written' }));
      const adopted = event.chats.filter((c) => !this.refuse.has(c.chatId)).map((c) => c.chatId);
      queueMicrotask(() =>
        this.emit(
          {
            type: 'patch.chat_adopt.response',
            requestId: event.requestId,
            hostId,
            adopted,
            refused,
          },
          hostId,
        ),
      );
    }
  }
}

describe('replacing a host', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-replace-host-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function boot(link: FakeHosts) {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(43));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 's1', surfaceKind: 'mobile', label: 'p', issuedAt: 1 });
    // d1 is registered first, so it is the Manager's home; d2 is the old host.
    registry.setDaemonKey({ hostId: 'd1', publicKey: user.publicKey, issuedAt: 1 });
    registry.setDaemonKey({ hostId: 'd2', publicKey: user.publicKey, issuedAt: 1 });
    registry.setHostName('d1', 'New box');
    registry.setHostName('d2', 'Old box');
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 's1',
      surfaceKind: 'mobile',
      label: 'p',
    });
    const built = await buildAll({ logger: false, registry, hostLink: link });
    const spawn = (chatId: string, folder: string) =>
      link.emit(
        { type: 'chat.spawned', chatId, hostId: 'd2', folder, model: 'claude-opus-5-5' },
        'd2',
      );
    spawn('c1', '/work/a');
    spawn('c2', '/work/a');
    spawn('c3', '/work/b');
    const say = (chatId: string, seq: number, session?: string) =>
      built.chatLogStore.commit({
        type: 'chat.message',
        chatId,
        role: 'assistant',
        content: `entry ${seq}`,
        seq,
        ...(session ? { nativeRef: { harness: 'claude', sessionId: session, id: `u${seq}` } } : {}),
      } as WireEvent);
    for (let seq = 0; seq < 8; seq++) say('c1', seq, seq < 7 ? 'old-session' : 'current-session');
    say('c2', 0);
    const headers = { authorization: `Bearer ${jwt}` };
    const get = (url: string) => built.app.inject({ method: 'GET', url, headers });
    const post = (url: string, body: unknown) =>
      built.app.inject({ method: 'POST', url, headers, payload: body as object });
    return { built, registry, get, post };
  }

  it('the plan lists every folder the old host’s chats use, which the new host lacks, and where sessions live', async () => {
    const link = new FakeHosts();
    link.present.add('/work/a');
    const { built, get } = await boot(link);
    try {
      const res = await get('/api/hosts/d2/replace?with=d1');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        from: { hostId: 'd2', name: 'Old box' },
        to: { hostId: 'd1', name: 'New box' },
        chats: 3,
        folders: [
          { folder: '/work/a', chats: 2, present: true },
          { folder: '/work/b', chats: 1, present: false },
        ],
        missing: ['/work/b'],
        sessions: [{ provider: 'claude', path: '~/.patch/chats/<chat id>/claude', chats: 1 }],
        // A host does not report its home, so the plan says what it assumed.
        assumedHome: '~/.patch',
      });
    } finally {
      await built.app.close();
    }
  });

  it('every job that runs on the old host is listed in the plan and moves with its chats', async () => {
    const link = new FakeHosts();
    link.present.add('/work/a').add('/work/b');
    const { built, get, post } = await boot(link);
    try {
      const cron = { type: 'cron' as const, expression: '0 9 * * *' };
      const spawn = built.jobs.create({
        name: 'morning',
        trigger: cron,
        action: { type: 'spawn', hostId: 'd2', folder: '/work/a', prompt: 'go' },
      });
      const gated = built.jobs.create({
        name: 'gated',
        trigger: cron,
        gate: { hostId: 'd2', folder: '/work/b', command: 'true' },
        action: { type: 'spawn', hostId: 'd1', folder: '/elsewhere', prompt: 'go' },
      });
      const other = built.jobs.create({
        name: 'stays',
        trigger: cron,
        action: { type: 'script', hostId: 'd1', folder: '/elsewhere', command: 'true' },
      });

      const planned = (await get('/api/hosts/d2/replace?with=d1')).json() as {
        jobs: Array<{ jobId: string; name: string }>;
      };
      expect(planned.jobs.map((j) => j.name).sort()).toEqual(['gated', 'morning']);

      const res = await post('/api/hosts/d2/replace', { with: 'd1' });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { jobs: string[] }).jobs.sort()).toEqual([gated.id, spawn.id].sort());
      expect(built.jobs.get(spawn.id)?.action).toMatchObject({ hostId: 'd1', folder: '/work/a' });
      expect(built.jobs.get(gated.id)?.gate).toMatchObject({ hostId: 'd1', folder: '/work/b' });
      expect(built.jobs.get(other.id)?.action).toMatchObject({ hostId: 'd1' });
    } finally {
      await built.app.close();
    }
  });

  it('a refused chat keeps the old host, and its jobs stay with it until everything moves', async () => {
    const link = new FakeHosts();
    link.present.add('/work/a').add('/work/b');
    link.refuse.add('c2');
    const { built, post } = await boot(link);
    try {
      const job = built.jobs.create({
        name: 'morning',
        trigger: { type: 'cron', expression: '0 9 * * *' },
        action: { type: 'spawn', hostId: 'd2', folder: '/work/a', prompt: 'go' },
      });
      expect((await post('/api/hosts/d2/replace', { with: 'd1' })).statusCode).toBe(502);
      expect(built.jobs.get(job.id)?.action).toMatchObject({ hostId: 'd2' });
    } finally {
      await built.app.close();
    }
  });

  it('refuses until a missing folder is confirmed, naming it', async () => {
    const link = new FakeHosts();
    link.present.add('/work/a');
    const { built, post } = await boot(link);
    try {
      const res = await post('/api/hosts/d2/replace', { with: 'd1' });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'folders_missing', missing: ['/work/b'] });
      expect(link.adopted).toEqual([]);
      expect(built.chatRegistry.get('c3')?.hostId).toBe('d2');
    } finally {
      await built.app.close();
    }
  });

  it('moves every chat, continuing each from the server’s high-water mark, hands over held messages and removes the old host', async () => {
    const link = new FakeHosts();
    link.present.add('/work/a');
    const { built, registry, post } = await boot(link);
    try {
      const res = await post('/api/hosts/d2/replace', { with: 'd1', withoutFolders: ['/work/b'] });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, moved: 3, withoutFolders: ['/work/b'] });

      const byId = new Map(link.adopted.map((c) => [c.chatId, c]));
      expect(byId.get('c1')).toMatchObject({
        folder: '/work/a',
        nextSeq: 8,
        sessionId: 'current-session',
        model: 'claude-opus-5-5',
      });
      expect(byId.get('c2')).toMatchObject({ nextSeq: 1 });
      expect(byId.get('c2')?.sessionId).toBeUndefined();
      // A chat the server holds no entries for starts at 0; its folder still moves with it.
      expect(byId.get('c3')).toMatchObject({ nextSeq: 0, folder: '/work/b' });

      for (const id of ['c1', 'c2', 'c3']) expect(built.chatRegistry.get(id)?.hostId).toBe('d1');
      expect(link.handedOver).toEqual([{ from: 'd2', to: 'd1' }]);
      expect(registry.isRegisteredHost('d2')).toBe(false);
      expect(link.forgotten).toContain('d2');
    } finally {
      await built.app.close();
    }
  });

  it('a chat the new host could not take keeps the old host, and asking again moves only what is left', async () => {
    const link = new FakeHosts();
    link.present.add('/work/a').add('/work/b');
    link.refuse.add('c2');
    const { built, registry, post } = await boot(link);
    try {
      const res = await post('/api/hosts/d2/replace', { with: 'd1' });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({
        error: 'chats_not_taken',
        moved: 2,
        refused: [{ chatId: 'c2' }],
      });
      expect(built.chatRegistry.get('c1')?.hostId).toBe('d1');
      expect(built.chatRegistry.get('c2')?.hostId).toBe('d2');
      expect(registry.isRegisteredHost('d2')).toBe(true);

      link.refuse.clear();
      link.adopted = [];
      const again = await post('/api/hosts/d2/replace', { with: 'd1' });
      expect(again.statusCode).toBe(200);
      expect(link.adopted.map((c) => c.chatId)).toEqual(['c2']);
      expect(registry.isRegisteredHost('d2')).toBe(false);
    } finally {
      await built.app.close();
    }
  });

  it('refuses the Manager’s home, a host replacing itself, an unknown host and an offline new host', async () => {
    const link = new FakeHosts();
    const { built, registry, post, get } = await boot(link);
    try {
      expect((await post('/api/hosts/d1/replace', { with: 'd2' })).json()).toMatchObject({
        error: 'manager_home',
      });
      expect((await post('/api/hosts/d2/replace', { with: 'd2' })).statusCode).toBe(400);
      expect((await post('/api/hosts/d2/replace', {})).json()).toMatchObject({
        error: 'with_required',
      });
      expect((await get('/api/hosts/d2/replace?with=nope')).statusCode).toBe(404);
      registry.setDaemonKey({ hostId: 'd3', publicKey: 'x', issuedAt: 1 });
      expect((await get('/api/hosts/d2/replace?with=d3')).json()).toMatchObject({
        error: 'host_offline',
      });
    } finally {
      await built.app.close();
    }
  });

  it('a new host that does not answer is a timeout, and nothing moves', async () => {
    const link = new FakeHosts();
    link.silent = true;
    const user = generateUserKeypair(() => new Uint8Array(32).fill(44));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 's1', surfaceKind: 'mobile', label: 'p', issuedAt: 1 });
    registry.setDaemonKey({ hostId: 'd1', publicKey: user.publicKey, issuedAt: 1 });
    registry.setDaemonKey({ hostId: 'd2', publicKey: user.publicKey, issuedAt: 1 });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 's1',
      surfaceKind: 'mobile',
      label: 'p',
    });
    const built = await buildAll({
      logger: false,
      registry,
      hostLink: link,
      hostReplaceTimeoutMs: 50,
    });
    try {
      link.emit({ type: 'chat.spawned', chatId: 'c1', hostId: 'd2', folder: '/w' }, 'd2');
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/hosts/d2/replace',
        headers: { authorization: `Bearer ${jwt}` },
        payload: { with: 'd1' },
      });
      expect(res.statusCode).toBe(504);
      expect(built.chatRegistry.get('c1')?.hostId).toBe('d2');
      expect(registry.isRegisteredHost('d2')).toBe(true);
    } finally {
      await built.app.close();
    }
  });
});
