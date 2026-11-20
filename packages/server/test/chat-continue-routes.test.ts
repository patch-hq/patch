// Linked chats (spec/04 § Provider switches, § Moving to another host) — the
// server half: a provider switch, a move or a lost session drafts a new chat
// naming the one it continues, with a visible first message drafted from the
// server's record; sending that draft spawns the chat and links the two, both
// ways, on every chat.state the server sends.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessHostLink } from '../src/host-link.js';
import { draftLinkedMessage } from '../src/linked-chat.js';

/** Hosts that confirm every spawn, and answer an owed retire as the test says. */
class FakeHosts extends InProcessHostLink {
  retireAnswer: 'ok' | 'not_found' | 'silent' = 'ok';
  constructor() {
    super();
    this.addOnlineHost('d1');
    this.addOnlineHost('d2');
  }
  override sendTo(hostId: string, surfaceId: string, event: WireEvent): void {
    super.sendTo(hostId, surfaceId, event);
    if (event.type === 'patch.chat_move.request' && this.retireAnswer !== 'silent') {
      const ok = this.retireAnswer === 'ok';
      queueMicrotask(() =>
        this.emit(
          {
            type: 'patch.chat_move.response',
            requestId: event.requestId,
            hostId,
            chatId: event.chatId,
            op: event.op,
            ok,
            ...(ok ? {} : { error: { code: 'not_found' as const, message: 'gone' } }),
          },
          hostId,
        ),
      );
    }
  }
  override send(surfaceId: string, event: WireEvent): void {
    super.send(surfaceId, event);
    if (event.type === 'chat.spawn_request' && event.chatId) {
      const { chatId, hostId, folder } = event;
      queueMicrotask(() => this.emit({ type: 'chat.spawned', chatId, hostId, folder }, hostId));
    }
  }
}

const message = (seq: number, role: 'user' | 'assistant' | 'system', content: string) =>
  ({ type: 'chat.message', chatId: 'c1', role, content, seq }) as const;

describe('linked chats', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-linked-chat-'));
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
      {
        type: 'chat.spawned',
        chatId: 'c1',
        hostId: 'd1',
        folder: '/Users/tom/Unite',
        model: 'claude-opus-5-5',
      },
      'd1',
    );
    built.chatLogStore.commit(message(0, 'user', 'make a plan'));
    built.chatLogStore.commit(message(1, 'assistant', 'the plan is ready: step one, step two'));
    built.chatLogStore.commit(message(2, 'user', 'now build step one'));
    const headers = { authorization: `Bearer ${jwt}` };
    const post = (url: string, body: unknown) =>
      built.app.inject({ method: 'POST', url, headers, payload: body as object });
    return { built, post };
  }

  it('a provider switch drafts a new chat on the same host and folder, naming the chat it continues', async () => {
    const link = new FakeHosts();
    const { built, post } = await boot(link);
    try {
      const res = await post('/api/chats/c1/continue', { model: 'gpt-5.5' });
      expect(res.statusCode).toBe(201);
      const { draft } = res.json() as {
        draft: { id: string; hostId: string; folder: string; model: string; text: string };
      };
      expect(draft).toMatchObject({
        hostId: 'd1',
        folder: '/Users/tom/Unite',
        model: 'gpt-5.5',
        continuedFrom: 'c1',
      });
      expect(draft.text).toContain('make a plan');
      expect(draft.text).toContain('the plan is ready');
      expect(draft.text).toContain('Still unanswered:\n> now build step one');
      // Server-owned, so every surface lists it.
      expect(built.newChatDrafts.list().map((d) => d.id)).toContain(draft.id);
      // Drafting changes nothing about the old chat.
      expect(built.chatRegistry.get('c1')?.continuedIn).toBeUndefined();
    } finally {
      await built.app.close();
    }
  });

  it('a move drafts the new chat on the chosen host and folder, and keeps the model', async () => {
    const link = new FakeHosts();
    const { built, post } = await boot(link);
    try {
      const res = await post('/api/chats/c1/move', { hostId: 'd2', folder: '/home/tom/Unite' });
      expect(res.statusCode).toBe(201);
      expect(res.json().draft).toMatchObject({
        hostId: 'd2',
        folder: '/home/tom/Unite',
        model: 'claude-opus-5-5',
        continuedFrom: 'c1',
      });
      expect(res.json().draft.text).toContain('on Mac in /Users/tom/Unite');
      // Nothing is sent to either host: no export, no import, no session copy.
      expect(link.sent.filter((s) => s.event.type === 'patch.chat_move.request')).toHaveLength(0);
    } finally {
      await built.app.close();
    }
  });

  it('a move needs a host and an absolute folder, other than where the chat already runs', async () => {
    const link = new FakeHosts();
    const { built, post } = await boot(link);
    try {
      expect((await post('/api/chats/c1/move', { folder: '/x' })).json().error).toBe(
        'hostId_required',
      );
      expect((await post('/api/chats/c1/move', { hostId: 'd2', folder: 'x' })).json().error).toBe(
        'folder_required',
      );
      expect(
        (await post('/api/chats/c1/move', { hostId: 'd1', folder: '/Users/tom/Unite' })).json()
          .error,
      ).toBe('same_folder');
      expect((await post('/api/chats/c1/move', { hostId: 'nope', folder: '/x' })).statusCode).toBe(
        404,
      );
      expect((await post('/api/chats/zz/continue', {})).statusCode).toBe(404);
      expect((await post('/api/chats/thread_manager/continue', {})).statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('sending the draft spawns the chat and links both ways, on the broadcast and the list', async () => {
    const link = new FakeHosts();
    const { built, post } = await boot(link);
    try {
      const res = await post('/api/chats', {
        hostId: 'd1',
        folder: '/Users/tom/Unite',
        model: 'gpt-5.5',
        continuedFrom: 'c1',
      });
      expect(res.statusCode).toBe(202);
      const { chatId } = res.json() as { chatId: string };
      expect(built.chatRegistry.get(chatId)?.continuedFrom).toBe('c1');
      expect(built.chatRegistry.get('c1')?.continuedIn).toBe(chatId);
      expect(built.chatRegistry.stateEventFor('c1')).toMatchObject({ continuedIn: chatId });
      expect(built.chatRegistry.stateEventFor(chatId)).toMatchObject({ continuedFrom: 'c1' });

      // A host's own chat.state never carries the link; the server stamps it.
      const relayed: WireEvent[] = [];
      built.wsHub.broadcastChatState = (e) => void relayed.push(e);
      link.emit(
        {
          type: 'chat.state',
          chatId: 'c1',
          permissionMode: 'auto',
          activity: 'idle',
          lastUpdated: 5,
        },
        'd1',
      );
      expect(built.chatRegistry.get('c1')?.continuedIn).toBe(chatId);

      // Continuing the old chat a second time is refused: the thread carries on in the new one.
      const again = await post('/api/chats/c1/continue', { model: 'gpt-5.5' });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ error: 'already_continued', continuedIn: chatId });
      const spawnAgain = await post('/api/chats', {
        hostId: 'd1',
        folder: '/Users/tom/Unite',
        continuedFrom: 'c1',
      });
      expect(spawnAgain.statusCode).toBe(409);
    } finally {
      await built.app.close();
    }
  });

  it('a spawn continuing a chat the server does not know is refused before anything is sent', async () => {
    const link = new FakeHosts();
    const { built, post } = await boot(link);
    try {
      const res = await post('/api/chats', { hostId: 'd1', folder: '/x', continuedFrom: 'zz' });
      expect(res.statusCode).toBe(404);
      expect(link.sent.filter((s) => s.event.type === 'chat.spawn_request')).toHaveLength(0);
    } finally {
      await built.app.close();
    }
  });

  it('a host finishing its start-up inventory is reconciled, after any owed retire of an old moved copy', async () => {
    writeFileSync(join(dir, 'pending-retires.json'), JSON.stringify({ old1: 'd1' }));
    const link = new FakeHosts();
    const { built } = await boot(link);
    try {
      link.emit({ type: 'folders.list', hostId: 'd1', roots: [], recent: [] }, 'd1');
      await new Promise((r) => setTimeout(r, 20));
      const sent = link.sent.filter((s) => s.hostId === 'd1').map((s) => s.event.type);
      expect(sent).toContain('patch.chat_move.request');
      expect(sent.indexOf('patch.chat_move.request')).toBeLessThan(sent.indexOf('host.reconciled'));
      // Paid once: the next connect owes nothing.
      link.emit({ type: 'folders.list', hostId: 'd1', roots: [], recent: [] }, 'd1');
      await new Promise((r) => setTimeout(r, 20));
      expect(link.sent.filter((s) => s.event.type === 'patch.chat_move.request')).toHaveLength(1);
      // A host with nothing owed is reconciled straight away.
      link.emit({ type: 'folders.list', hostId: 'd2', roots: [], recent: [] }, 'd2');
      await new Promise((r) => setTimeout(r, 5));
      expect(link.sent.some((s) => s.hostId === 'd2' && s.event.type === 'host.reconciled')).toBe(
        true,
      );
    } finally {
      await built.app.close();
    }
  });
});

function message2(seq: number, content: string, role: 'user' | 'assistant' | 'system') {
  return { type: 'chat.message', chatId: 'c1', role, content, seq };
}

describe('draftLinkedMessage', () => {
  const base = { name: 'Plan the launch', folder: '/w', hostName: 'Mac', model: 'claude-opus-5-5' };

  it('names the chat it continues and quotes the last request and how the reply ended', () => {
    const text = draftLinkedMessage({
      ...base,
      events: [
        message2(0, 'first ask', 'user'),
        message2(1, 'first answer', 'assistant'),
        message2(2, 'second ask\nwith two lines', 'user'),
        message2(3, 'compaction note', 'system'),
        message2(4, 'second answer', 'assistant'),
      ].map((m) => m as unknown as WireEvent),
    });
    expect(text).toBe(
      [
        `This continues "Plan the launch" (Opus 5.5 on Mac in /w). You can't see that chat: this message is everything that carries over.`,
        'The last thing I asked:\n> second ask\n> with two lines',
        'How the last reply ended:\n> second answer',
      ].join('\n\n'),
    );
  });

  it('keeps the head of a long request and the end of a long reply', () => {
    const text = draftLinkedMessage({
      ...base,
      name: null,
      model: null,
      events: [
        message2(0, 'A'.repeat(2_500) + 'TAIL', 'user'),
        message2(1, 'HEAD' + 'B'.repeat(3_500), 'assistant'),
      ].map((m) => m as unknown as WireEvent),
    });
    expect(text.startsWith('This continues a chat (on Mac in /w).')).toBe(true);
    expect(text).not.toContain('TAIL');
    expect(text).not.toContain('HEAD');
    expect(text).toContain('…');
  });

  it('lists every request since the last reply as still unanswered', () => {
    const text = draftLinkedMessage({
      ...base,
      events: [message2(0, 'one', 'user'), message2(1, 'two', 'user')].map(
        (m) => m as unknown as WireEvent,
      ),
    });
    expect(text).toContain('Still unanswered, in order:\n> one\n\n> two');
    expect(text).not.toContain('The last thing I asked');
  });
});
