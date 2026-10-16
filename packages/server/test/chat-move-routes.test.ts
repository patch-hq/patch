// Moving a chat between hosts (spec/04 § Moving a chat to another host) — the
// server half: it drives export → import → retire across two machines, points
// its mirror at the new one, and stops loudly at whichever step fails. The
// host half is tested between two real hosts in
// packages/host/test/chat-move.test.ts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { ChatMoveOp, WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';

type Req = Extract<WireEvent, { type: 'patch.chat_move.request' }>;
type Res = Extract<WireEvent, { type: 'patch.chat_move.response' }>;
type Answer = Pick<Res, 'ok'> & Partial<Pick<Res, 'bundle' | 'error'>>;

const BUNDLE = {
  chatId: 'c1',
  sourceFolder: '/Users/tom/Unite',
  files: [{ path: 'chat/meta.json', data: 'e30=' }],
  attachments: {},
};

/** Two machines, each answering move steps with whatever the test says. */
class FakeHosts extends InProcessHostLink {
  readonly steps: Array<{ hostId: string; op: ChatMoveOp; event: Req }> = [];
  readonly restores: Array<{ hostId: string; event: WireEvent }> = [];
  constructor(private readonly answer: (hostId: string, e: Req) => Answer | null) {
    super();
    this.addOnlineHost('d2');
  }
  override sendTo(hostId: string, surfaceId: string, event: WireEvent): void {
    super.sendTo(hostId, surfaceId, event);
    if (event.type === 'patch.log_restore') this.restores.push({ hostId, event });
    if (event.type !== 'patch.chat_move.request') return;
    this.steps.push({ hostId, op: event.op, event });
    const a = this.answer(hostId, event);
    if (a === null) return;
    queueMicrotask(() =>
      this.emit(
        {
          type: 'patch.chat_move.response',
          requestId: event.requestId,
          hostId,
          chatId: event.chatId,
          op: event.op,
          ...a,
        },
        hostId,
      ),
    );
  }
}

const happy = (_d: string, e: Req): Answer =>
  e.op === 'export' ? { ok: true, bundle: BUNDLE } : { ok: true };

describe('POST /api/chats/:id/move', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-chat-move-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function boot(link: FakeHosts) {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(41));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({ surfaceId: 's1', surfaceKind: 'mobile', label: 'p', issuedAt: 1 });
    registry.setDaemonKey({ hostId: 'd1', publicKey: user.publicKey, issuedAt: 1 });
    registry.setDaemonKey({ hostId: 'd2', publicKey: user.publicKey, issuedAt: 1 });
    registry.setHostName('d1', 'Mac');
    registry.setHostName('d2', 'Hetzner');
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 's1',
      surfaceKind: 'mobile',
      label: 'p',
    });
    const built = await buildAll({ logger: false, registry, hostLink: link });
    link.emit(
      { type: 'chat.spawned', chatId: 'c1', hostId: 'd1', folder: '/Users/tom/Unite' },
      'd1',
    );
    const headers = { authorization: `Bearer ${jwt}` };
    const move = (body: unknown) =>
      built.app.inject({
        method: 'POST',
        url: '/api/chats/c1/move',
        headers,
        payload: body as object,
      });
    const host = async () => {
      const res = await built.app.inject({ method: 'GET', url: '/api/chats', headers });
      const chats = (
        res.json() as { chats: Array<{ chatId: string; hostId: string; folder: string }> }
      ).chats;
      return chats.find((c) => c.chatId === 'c1');
    };
    return { built, move, host };
  }

  it('exports from the old host, imports on the new one with the bundle, retires the old copy', async () => {
    const link = new FakeHosts(happy);
    const { built, move, host } = await boot(link);
    try {
      const res = await move({ hostId: 'd2', folder: '/home/tom/Unite' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        chatId: 'c1',
        hostId: 'd2',
        folder: '/home/tom/Unite',
      });
      expect(link.steps.map((s) => [s.hostId, s.op])).toEqual([
        ['d1', 'export'],
        ['d2', 'import'],
        ['d1', 'retire'],
      ]);
      expect(link.steps[1]!.event).toMatchObject({ folder: '/home/tom/Unite', bundle: BUNDLE });
      expect(await host()).toMatchObject({ hostId: 'd2', folder: '/home/tom/Unite' });
    } finally {
      await built.app.close();
    }
  });

  it('a busy chat is refused at export, with the host named, and stays put', async () => {
    const link = new FakeHosts((_d, e) =>
      e.op === 'export'
        ? { ok: false, error: { code: 'busy', message: 'this chat is mid-turn' } }
        : { ok: true },
    );
    const { built, move, host } = await boot(link);
    try {
      const res = await move({ hostId: 'd2', folder: '/home/tom/Unite' });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'busy', message: 'Mac: this chat is mid-turn' });
      expect(link.steps.map((s) => s.op)).toEqual(['export']);
      expect((await host())?.hostId).toBe('d1');
    } finally {
      await built.app.close();
    }
  });

  it('a failed import releases the chat on the old host and leaves it there', async () => {
    const link = new FakeHosts((_d, e) =>
      e.op === 'export'
        ? { ok: true, bundle: BUNDLE }
        : e.op === 'import'
          ? {
              ok: false,
              error: { code: 'folder_not_found', message: '/home/tom/Unite is not a folder' },
            }
          : { ok: true },
    );
    const { built, move, host } = await boot(link);
    try {
      const res = await move({ hostId: 'd2', folder: '/home/tom/Unite' });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toBe('Hetzner: /home/tom/Unite is not a folder');
      expect(link.steps.map((s) => [s.hostId, s.op])).toEqual([
        ['d1', 'export'],
        ['d2', 'import'],
        ['d1', 'release'],
      ]);
      expect((await host())?.hostId).toBe('d1');
    } finally {
      await built.app.close();
    }
  });

  it('a retire that fails still counts as moved, and says the old copy is still there', async () => {
    const link = new FakeHosts((_d, e) =>
      e.op === 'retire'
        ? { ok: false, error: { code: 'internal', message: 'EACCES' } }
        : happy(_d, e),
    );
    const { built, move, host } = await boot(link);
    try {
      const res = await move({ hostId: 'd2', folder: '/home/tom/Unite' });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ error: 'retire_failed', hostId: 'd2' });
      expect(res.json().message).toContain('Moved to Hetzner, but Mac kept its copy');
      expect((await host())?.hostId).toBe('d2');
    } finally {
      await built.app.close();
    }
  });

  it('refuses a move to the host it is already on, an offline host, or no folder', async () => {
    const link = new FakeHosts(happy);
    const { built, move } = await boot(link);
    try {
      expect((await move({ hostId: 'd1', folder: '/x' })).json().error).toBe('same_host');
      expect((await move({ hostId: 'd2' })).json().error).toBe('folder_required');
      expect((await move({ hostId: 'd2', folder: 'relative/path' })).statusCode).toBe(400);
      expect((await move({ hostId: 'nope', folder: '/x' })).statusCode).toBe(404);
      link.forget('d2');
      const off = await move({ hostId: 'd2', folder: '/x' });
      expect(off.statusCode).toBe(503);
      expect(off.json().message).toBe('Hetzner is offline');
      expect(link.steps).toEqual([]);
    } finally {
      await built.app.close();
    }
  });

  describe('taking over from an offline host', () => {
    const message = (seq: number, content: string): WireEvent => ({
      type: 'chat.message',
      chatId: 'c1',
      role: seq % 2 === 0 ? 'user' : 'assistant',
      content,
      seq,
    });

    it('builds the chat from the server copy, imports it on the target, and retires the old copy when the old host returns', async () => {
      const link = new FakeHosts(happy);
      const { built, move } = await boot(link);
      try {
        built.chatLogStore.commit(message(0, 'make a plan'));
        built.chatLogStore.commit(message(1, 'the plan is ready'));
        const attachment = {
          id: 'ATTACH01',
          name: 'plan.txt',
          mimeType: 'text/plain',
          kind: 'file' as const,
        };
        built.chatLogStore.commit({
          type: 'chat.message',
          chatId: 'c1',
          role: 'user',
          content: 'see file',
          attachments: [attachment],
          seq: 2,
        });
        mkdirSync(join(dir, 'attachments', 'c1'), { recursive: true });
        writeFileSync(join(dir, 'attachments', 'c1', attachment.id), 'contents');
        link.emit(
          {
            type: 'chat.state',
            chatId: 'c1',
            permissionMode: 'auto',
            activity: 'idle',
            lastUpdated: 1234,
            lastUserActivity: 1200,
            folder: '/Users/tom/Unite',
            goal: 'Ship the plan',
            reminder: 'Check the risks',
            pinned: true,
            pinnedAt: 1100,
            hidden: true,
            snoozedUntil: 1_700_000_200_000,
            statusSummary: 'Choose a route',
            statusKind: 'question',
            statusDeclared: true,
            pendingWake: { message: 'check later', fireAt: 1_700_000_100_000 },
          },
          'd1',
        );
        link.emit(
          {
            type: 'chat.branches',
            chatId: 'c1',
            activeBranchId: 'c1-b1',
            branches: [
              {
                branchId: 'c1-b0',
                parentBranchId: null,
                forkFromSeq: null,
                label: 'main',
                createdAt: 1000,
              },
              {
                branchId: 'c1-b1',
                parentBranchId: 'c1-b0',
                forkFromSeq: 0,
                label: 'edit 1',
                createdAt: 1100,
              },
            ],
          },
          'd1',
        );
        link.forget('d1');

        const res = await move({ hostId: 'd2', folder: '/home/tom/Unite' });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
          ok: true,
          chatId: 'c1',
          hostId: 'd2',
          folder: '/home/tom/Unite',
        });
        // The old host is never asked to export; only the target is spoken to.
        expect(link.steps.map((s) => [s.hostId, s.op])).toEqual([['d2', 'import']]);
        const imp = link.steps[0]!.event;
        expect(imp.folder).toBe('/home/tom/Unite');
        expect(imp.bundle?.sourceFolder).toBe('/Users/tom/Unite');
        expect(imp.bundle?.files.map((f) => f.path)).toEqual([
          'chat/meta.json',
          'chat/wake.json',
          'attachment/ATTACH01-plan.txt',
        ]);
        expect(imp.bundle?.attachments).toEqual({ ATTACH01: attachment });
        const meta = JSON.parse(
          Buffer.from(imp.bundle!.files[0]!.data, 'base64').toString('utf8'),
        ) as Record<string, unknown>;
        expect(meta).toMatchObject({
          chatId: 'c1',
          folder: '/Users/tom/Unite',
          goal: 'Ship the plan',
          reminder: 'Check the risks',
          pinned: true,
          pinnedAt: 1100,
          hidden: true,
          snoozedUntil: 1_700_000_200_000,
          declaredStatus: { kind: 'question', text: 'Choose a route', at: 1234 },
          activeBranchId: 'c1-b1',
          branches: [
            { branchId: 'c1-b0', parentBranchId: null },
            { branchId: 'c1-b1', parentBranchId: 'c1-b0' },
          ],
          updatedAt: 1234,
          lastUserActivity: 1200,
          nextSeq: 0,
        });
        // The transcript is part of the import transaction: the target cannot
        // announce or wake the chat while it is still empty.
        expect(imp.bundle?.events?.map((e) => (e as { seq: number }).seq)).toEqual([0, 1, 2]);
        expect(link.restores).toHaveLength(0);
        expect(built.chatRegistry.get('c1')).toMatchObject({
          hostId: 'd2',
          folder: '/home/tom/Unite',
        });

        // The old host comes back and announces the end of its inventory: it
        // is retired before the server releases any interrupted work.
        link.addOnlineHost('d1');
        link.emit({ type: 'folders.list', hostId: 'd1', roots: [], recent: [] }, 'd1');
        await new Promise((r) => setTimeout(r, 20));
        expect(link.steps.map((s) => [s.hostId, s.op])).toEqual([
          ['d2', 'import'],
          ['d1', 'retire'],
        ]);
        expect(link.sent.some((s) => s.event.type === 'host.reconciled' && s.hostId === 'd1')).toBe(
          true,
        );
        link.dropOnlineHost('d1');
        link.addOnlineHost('d1');
        link.emit({ type: 'folders.list', hostId: 'd1', roots: [], recent: [] }, 'd1');
        await new Promise((r) => setTimeout(r, 20));
        expect(link.steps.filter((s) => s.op === 'retire')).toHaveLength(1);
      } finally {
        await built.app.close();
      }
    });

    it('can be chosen while the old host is online: no export, and the old host is told at once to stop and retire', async () => {
      const link = new FakeHosts(happy);
      const { built, move, host } = await boot(link);
      try {
        built.chatLogStore.commit(message(0, 'make a plan'));
        const res = await move({
          hostId: 'd2',
          folder: '/home/tom/Unite',
          fromServerCopy: true,
        });
        expect(res.statusCode).toBe(200);
        expect(link.steps.map((s) => [s.hostId, s.op])).toEqual([
          ['d2', 'import'],
          ['d1', 'retire'],
        ]);
        expect(link.steps[1]!.event.force).toBe(true);
        expect(link.steps[0]!.event.bundle?.events).toHaveLength(1);
        expect(link.restores).toHaveLength(0);
        expect(await host()).toMatchObject({ hostId: 'd2' });
      } finally {
        await built.app.close();
      }
    });

    it('an old host that is online but fails to retire is reported, and the chat is still on the new host', async () => {
      const link = new FakeHosts((_d, e) =>
        e.op === 'retire'
          ? { ok: false, error: { code: 'internal', message: 'disk said no' } }
          : { ok: true },
      );
      const { built, move, host } = await boot(link);
      try {
        built.chatLogStore.commit(message(0, 'hi'));
        const res = await move({ hostId: 'd2', folder: '/home/tom/Unite', fromServerCopy: true });
        expect(res.statusCode).toBe(502);
        expect(res.json().error).toBe('retire_failed');
        expect((await host())?.hostId).toBe('d2');
      } finally {
        await built.app.close();
      }
    });

    it('carries the blobs the transcript references', async () => {
      const link = new FakeHosts(happy);
      const { built, move } = await boot(link);
      try {
        built.chatLogStore.commit({
          type: 'chat.tool_result',
          chatId: 'c1',
          tool: 'Bash',
          callId: 'call-1',
          result: { output: 'x'.repeat(10_000) },
          seq: 0,
        } as WireEvent);
        const ref = built.chatLogStore.read('c1', -1)[0] as unknown as {
          result: { $blob: string };
        };
        link.forget('d1');
        await move({ hostId: 'd2', folder: '/home/tom/Unite' });
        const paths = link.steps[0]!.event.bundle!.files.map((f) => f.path);
        expect(paths).toContain(`blob/${ref.result.$blob}`);
      } finally {
        await built.app.close();
      }
    });

    it('a chat the server holds nothing for is refused, not moved empty', async () => {
      const link = new FakeHosts(happy);
      const { built, move, host } = await boot(link);
      try {
        link.forget('d1');
        const res = await move({ hostId: 'd2', folder: '/home/tom/Unite' });
        expect(res.statusCode).toBe(409);
        expect(res.json().error).toBe('no_server_copy');
        expect(link.steps).toEqual([]);
        expect((await host())?.hostId).toBe('d1');
      } finally {
        await built.app.close();
      }
    });

    it('still needs the target online, and a failed import leaves the chat where it was', async () => {
      const link = new FakeHosts((_d, e) =>
        e.op === 'import'
          ? { ok: false, error: { code: 'folder_not_found', message: '/nope is not a folder' } }
          : { ok: true },
      );
      const { built, move, host } = await boot(link);
      try {
        built.chatLogStore.commit(message(0, 'hi'));
        link.forget('d1');
        const bad = await move({ hostId: 'd2', folder: '/nope' });
        expect(bad.statusCode).toBe(400);
        expect((await host())?.hostId).toBe('d1');
        link.addOnlineHost('d1');
        await new Promise((r) => setTimeout(r, 20));
        expect(link.steps.filter((s) => s.op === 'retire')).toEqual([]);

        link.forget('d1');
        link.forget('d2');
        const off = await move({ hostId: 'd2', folder: '/home/tom/Unite' });
        expect(off.statusCode).toBe(503);
        expect(off.json().message).toBe('Hetzner is offline');
      } finally {
        await built.app.close();
      }
    });
  });
});
