// Unarchive a chat on the phone and chat in it, watched from the web app — the
// user's report "when I unarchive a chat on mobile and start chatting, it's not
// synced" (spec/03 § Account feed; decisions 26–28). REAL server and host
// (packages/server/test/e2e/harness.ts); the web side is the app's own PatchWs
// and chat store over a real socket; the phone is a wire client doing what the
// phone app sends.

import './helpers/nodeEncoding.js';
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { WireEvent } from '@patch/wire';
import { PatchWs } from '../api/ws.js';
import { saveCredential } from '../lib/credential.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';

// The browser's WebSocket, played by `ws` (the server's own dependency): jsdom
// has none that reaches a real server, and Node's dispatches events from another
// realm than jsdom's.
const requireFromServer = createRequire(
  join(dirname(fileURLToPath(import.meta.url)), '../../../server/package.json'),
);
globalThis.WebSocket = requireFromServer('ws') as typeof WebSocket;

// The real stack, from the server's e2e harness. Loaded by a path the web
// typecheck does not follow: the harness is server and host code, typed
// against Node, not the DOM.
interface TestClient {
  send(event: WireEvent): void;
  sendInput(input: { chatId: string; message: string; localId?: string }): void;
  on<T extends WireEvent['type']>(type: T, cb: (e: Extract<WireEvent, { type: T }>) => void): void;
  close(): Promise<void>;
}
interface E2EHarness {
  wsUrl: string;
  hostId: string;
  folder: string;
  built: {
    app: {
      inject(req: {
        method: string;
        url: string;
        headers?: Record<string, string>;
        payload?: unknown;
      }): Promise<{ json(): unknown }>;
    };
    chatRegistry: {
      get(chatId: string): { status?: string; chatStatus?: { state: string } } | undefined;
    };
    chatLogStore: { read(chatId: string, from: number): WireEvent[] };
    wsHub: unknown;
  };
  mintSurface(surfaceId: string): Promise<string>;
  connectSurface(surfaceId: string): Promise<TestClient>;
  close(): Promise<void>;
}
interface HarnessModule {
  startHarness(): Promise<E2EHarness>;
  expectReply(client: TestClient, chatId: string, label: string): Promise<unknown>;
  until(pred: () => boolean, timeoutMs: number, label: string): Promise<void>;
}
const harnessPath = '../../../server/test/e2e/harness.js';
const { startHarness, expectReply, until } = (await import(
  /* @vite-ignore */ harnessPath
)) as HarnessModule;

let h: E2EHarness | undefined;
let web: PatchWs | undefined;
afterEach(async () => {
  web?.close();
  web = undefined;
  if (h) await h.close();
  h = undefined;
});

async function archivedChat(harness: E2EHarness): Promise<string> {
  const jwt = await harness.mintSurface('srf-setup');
  const res = await harness.built.app.inject({
    method: 'POST',
    url: '/api/chats',
    headers: { authorization: `Bearer ${jwt}` },
    payload: { hostId: harness.hostId, folder: harness.folder },
  });
  const chatId = (res.json() as { chatId: string }).chatId;
  const setup = await harness.connectSurface('srf-setup-ws');
  setup.send({ type: 'chat.focus_change', chatId });
  setup.sendInput({ chatId, message: 'before archiving', localId: 'L0' });
  await expectReply(setup, chatId, 'first turn');
  await until(
    () => harness.built.chatRegistry.get(chatId)?.chatStatus?.state === 'idle',
    5000,
    'settled',
  );
  setup.send({ type: 'chat.archive_request', chatId, archived: true } as WireEvent);
  await until(
    () => harness.built.chatRegistry.get(chatId)?.status === 'archived',
    5000,
    'archived',
  );
  await setup.close();
  return chatId;
}

/** The web app as it boots: its chat list from REST, then its socket. */
async function bootWeb(harness: E2EHarness): Promise<void> {
  const jwt = await harness.mintSurface('srf-web');
  saveCredential(jwt);
  const list = await harness.built.app.inject({
    method: 'GET',
    url: '/api/chats',
    headers: { authorization: `Bearer ${jwt}` },
  });
  useChatStore.getState()._reset();
  useChatStore.getState().hydrate((list.json() as { chats: never[] }).chats);
  web = new PatchWs(`${harness.wsUrl}/ws`);
  web.connect();
  await until(() => usePresenceStore.getState().connection === 'connected', 5000, 'web connected');
  // The server has the web's feed resumed (its follow set) before the phone acts.
  const hub = harness.built.wsHub as unknown as {
    surfaces: Map<string, Set<{ followedChats?: Set<string> }>>;
  };
  await until(
    () => [...(hub.surfaces.get('srf-web') ?? [])].some((c) => c.followedChats !== undefined),
    5000,
    'web feed resumed',
  );
}

const seqs = (chatId: string): number[] =>
  (useChatStore.getState().timelines[chatId] ?? [])
    .filter((e) => e.kind === 'message' && e.localId === undefined && e.seq >= 0)
    .map((e) => e.seq)
    .sort((a, b) => a - b);

const recordSeqs = (harness: E2EHarness, chatId: string): number[] =>
  harness.built.chatLogStore
    .read(chatId, -1)
    .filter((e) => e.type === 'chat.message')
    .map((e) => (e as { seq: number }).seq);

describe('the web app while the phone unarchives a chat and chats in it', () => {
  it('lists the chat again and shows the message and reply live, without the chat being opened', async () => {
    h = await startHarness();
    const chatId = await archivedChat(h);
    await bootWeb(h);
    expect(useChatStore.getState().chats[chatId]).toBeUndefined();

    const phone = await h.connectSurface('srf-phone');
    phone.send({ type: 'feed.resume', follow: [] } as WireEvent);
    phone.send({ type: 'chat.archive_request', chatId, archived: false } as WireEvent);
    phone.send({ type: 'chat.focus_change', chatId });
    phone.sendInput({ chatId, message: 'back again', localId: 'L1' });
    await expectReply(phone, chatId, 'reply after unarchive');

    // Back in the web list.
    await until(
      () => useChatStore.getState().chats[chatId]?.status === 'active',
      5000,
      'web lists the chat again',
    );
    // The whole chat, live, though the web never opened it.
    await until(
      () => seqs(chatId).length === recordSeqs(h!, chatId).length,
      5000,
      'web holds the chat',
    );
    expect(seqs(chatId)).toEqual(recordSeqs(h, chatId));
    expect(useChatStore.getState().activeChatId).toBeNull();

    // A reconnect resumes from what the web holds: nothing lost, nothing twice.
    const before = seqs(chatId);
    web!.reconnectNow();
    await until(() => usePresenceStore.getState().connection === 'connected', 5000, 'reconnected');
    await new Promise((r) => setTimeout(r, 500));
    expect(seqs(chatId)).toEqual(before);
    await phone.close();
  });

  it('the reverse: the web app unarchives a chat and chats in it, and holds the whole chat; the phone sees it all', async () => {
    h = await startHarness();
    const chatId = await archivedChat(h);
    // The phone, following its list as the phone app does.
    const phone = await h.connectSurface('srf-phone');
    const phoneSeen = new Map<number, string>();
    phone.on('chat.message', (e) => {
      if (e.chatId === chatId && e.seq >= 0) phoneSeen.set(e.seq, e.content);
    });
    let phoneFollowed = false;
    phone.on('chat.state', (e) => {
      if (phoneFollowed || e.chatId !== chatId || e.status !== 'active') return;
      phoneFollowed = true;
      phone.send({ type: 'feed.follow', follow: [{ chatId, after: -1 }] } as WireEvent);
    });
    phone.send({ type: 'feed.resume', follow: [] } as WireEvent);

    await bootWeb(h);
    // The Archived section lists it; the person unarchives it there and opens it.
    const archived = await h.built.app.inject({
      method: 'GET',
      url: '/api/chats?archived=only',
      headers: { authorization: `Bearer ${await h.mintSurface('srf-web-rest')}` },
    });
    useChatStore.getState().mergeChats((archived.json() as { chats: never[] }).chats);
    useChatStore.getState().setArchived(chatId, false);
    web!.send({ type: 'chat.archive_request', chatId, archived: false } as WireEvent);
    useChatStore.getState().setActiveChat(chatId);
    web!.requestHistory(chatId);
    web!.send({ type: 'chat.input', chatId, message: 'from the desk', localId: 'W1' } as WireEvent);

    await until(
      () =>
        seqs(chatId).length === recordSeqs(h!, chatId).length && recordSeqs(h!, chatId).length >= 4,
      8000,
      'web holds the whole chat',
    );
    expect(seqs(chatId)).toEqual(recordSeqs(h, chatId));
    await until(() => phoneSeen.size === recordSeqs(h!, chatId).length, 5000, 'phone has it all');
    expect([...phoneSeen.keys()].sort((a, b) => a - b)).toEqual(recordSeqs(h, chatId));
    await phone.close();
  });
});
