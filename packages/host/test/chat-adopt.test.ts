// spec/11 § Replacing a host — the host half: a new host takes over an old
// host's chats, each continuing from the server's high-water mark under the
// same id, and says which of the old host's folders it does not have.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { AdoptedChat, WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { answerChatAdopt, answerFoldersCheck } from '../src/index.js';

const silent = pino({ level: 'silent' });

describe('taking over a replaced host’s chats', () => {
  let roots: string[];
  const tmp = (prefix: string): string => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    roots.push(d);
    return d;
  };
  beforeEach(() => {
    roots = [];
  });
  afterEach(() => {
    for (const d of roots) rmSync(d, { recursive: true, force: true });
  });

  function host(home = tmp('adopt-home-')) {
    const events: WireEvent[] = [];
    const metaStore = createMetaStore(home);
    const daemon = new Daemon({
      hostId: 'd1',
      metaStore,
      sdkBackend: {
        run: async function* () {
          yield { type: 'assistant', content: 'ok', sessionId: 'S1' };
          yield { type: 'result', sessionId: 'S1' };
        },
      },
      oauthAccessToken: 'x',
      emit: (e) => events.push(e),
      logger: silent,
      now: () => Date.now(),
    } as never);
    daemon.hydrate?.();
    return { daemon, metaStore, events, home };
  }

  const chat = (over: Partial<AdoptedChat> = {}): AdoptedChat => ({
    chatId: 'c1',
    folder: tmp('adopt-folder-'),
    name: 'Boiler',
    model: 'claude-opus-5-5',
    permissionMode: 'auto',
    sessionId: 'carried-session',
    nextSeq: 40,
    status: 'active',
    pinned: true,
    createdAt: 5,
    ...over,
  });

  const seqsOf = (events: WireEvent[], chatId: string): number[] =>
    events
      .filter((e) => (e as { chatId?: string }).chatId === chatId)
      .map((e) => (e as { seq?: number }).seq)
      .filter((s): s is number => typeof s === 'number' && s >= 0);

  it('writes the chat from the server’s record and continues from its high-water mark', async () => {
    const { daemon, metaStore, events } = host();
    const c = chat();
    daemon.adoptChat(c);
    expect(metaStore.read('c1')).toMatchObject({
      chatId: 'c1',
      folder: c.folder,
      name: 'Boiler',
      model: 'claude-opus-5-5',
      sessionId: 'carried-session',
      nextSeq: 40,
      pinned: true,
      createdAt: 5,
    });
    // The server hears the chat's state from its new host.
    expect(events.some((e) => e.type === 'chat.state' && e.chatId === 'c1')).toBe(true);
    const before = events.length;
    await daemon.sendInput({ chatId: 'c1', message: 'carry on', localId: 'l1' });
    expect(Math.min(...seqsOf(events.slice(before), 'c1'))).toBe(40);
  });

  it('keeps the position across a restart before the chat writes again', async () => {
    const first = host();
    first.daemon.adoptChat(chat());
    const second = host(first.home);
    await second.daemon.sendInput({ chatId: 'c1', message: 'after restart', localId: 'l2' });
    expect(Math.min(...seqsOf(second.events, 'c1'))).toBe(40);
  });

  it('a chat whose own directory came across too keeps what it has and only moves forward', () => {
    const { daemon, metaStore } = host();
    daemon.adoptChat(chat({ name: 'Carried name', nextSeq: 3 }));
    daemon.adoptChat(chat({ name: 'Server name', nextSeq: 12, sessionId: 'other' }));
    expect(metaStore.read('c1')).toMatchObject({
      name: 'Carried name',
      sessionId: 'carried-session',
      nextSeq: 12,
    });
    daemon.adoptChat(chat({ nextSeq: 2 }));
    expect(metaStore.read('c1')?.nextSeq).toBe(12);
  });

  it('a chat whose folder did not come across is taken and marked folder-missing, not dropped', () => {
    const { daemon, metaStore } = host();
    daemon.adoptChat(chat({ folder: '/no/such/folder/here' }));
    expect(metaStore.read('c1')).toMatchObject({ folderMissing: true });
    expect(daemon.chatState.get('c1')).toBeDefined();
  });

  it('names the folders that are not here', () => {
    const present = tmp('adopt-present-');
    expect(
      answerFoldersCheck(
        {
          type: 'patch.folders_check.request',
          requestId: 'r1',
          hostId: 'd1',
          folders: [present, '/no/such/folder'],
        },
        'd1',
      ),
    ).toEqual({
      type: 'patch.folders_check.response',
      requestId: 'r1',
      hostId: 'd1',
      missing: ['/no/such/folder'],
    });
  });

  it('one chat that cannot be taken is named with why; the rest still come', () => {
    const taken: string[] = [];
    const daemon = {
      adoptChat: (c: AdoptedChat) => {
        if (c.chatId === 'bad') throw new Error('meta.json could not be written');
        taken.push(c.chatId);
      },
    } as unknown as Daemon;
    const answer = answerChatAdopt(
      {
        type: 'patch.chat_adopt.request',
        requestId: 'r2',
        hostId: 'd1',
        chats: [chat({ chatId: 'a' }), chat({ chatId: 'bad' }), chat({ chatId: 'b' })],
      },
      daemon,
      silent,
      'd1',
    );
    expect(taken).toEqual(['a', 'b']);
    expect(answer).toEqual({
      type: 'patch.chat_adopt.response',
      requestId: 'r2',
      hostId: 'd1',
      adopted: ['a', 'b'],
      refused: [{ chatId: 'bad', message: 'meta.json could not be written' }],
    });
  });
});
