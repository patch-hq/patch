// Host shutdown must be bounded (spec/02 § Restarting the host). On 2026-11-12
// the host overran its 10 s deadline and sat frozen ~50 s: shutdown rewrote
// meta.json for every loaded chat (6,400 on that host), synchronously, so the
// event loop was blocked and not even the deadline timer could fire. These tests
// pin each thing that used to hold a shutdown up.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { WebSocketServer } from 'ws';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';
import { runShutdownSteps } from '../src/shutdownSteps.js';
import { buildControl } from '../src/control.js';
import { createServerLink } from '../src/serverLink.js';

const idle: SdkBackend = {
  run: async function* () {
    yield { type: 'result', sessionId: 'sess-1' };
  },
};

describe('flushHistory writes only the chats that moved', () => {
  it('leaves untouched chats alone however many are loaded', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-flush-'));
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-flush-folder-')));
    const logger = pino({ level: 'silent' });
    let id = 0;
    const metaStore = createMetaStore(home);
    const make = (store = metaStore) =>
      new Daemon({
        hostId: 'd1',
        metaStore: store,
        sdkBackend: idle,
        oauthAccessToken: 'fake-token',
        emit: () => {},
        logger,
        now: () => 1_700_000_000_000,
        generateChatId: () => `chat-${++id}`,
      });
    const first = make();
    const ids: string[] = [];
    for (let i = 0; i < 40; i += 1) ids.push(await first.spawnChat({ folder }));
    first.shutdown();

    // A fresh host loads all 40 from disk and then goes down without touching any.
    const updates: string[] = [];
    const counting = {
      ...metaStore,
      update: (chatId: string, mut: Parameters<typeof metaStore.update>[1]) => {
        updates.push(chatId);
        return metaStore.update(chatId, mut);
      },
    };
    const second = make(counting);
    second.hydrate();
    expect(second.chatState.size()).toBe(40);
    second.flushHistory();
    expect(updates).toEqual([]);
    second.shutdown();

    // One chat that moved is the only one written.
    const third = make(counting);
    third.hydrate();
    third.chatState.get(ids[7]!)!.nextSeq += 1;
    third.chatState.get(ids[7]!)!.lastUpdated += 1;
    third.flushHistory();
    expect(updates).toEqual([ids[7]]);
    // ...and once, not again at the next flush.
    third.flushHistory();
    expect(updates).toEqual([ids[7]]);
    third.shutdown();
  });
});

describe('runShutdownSteps', () => {
  it('runs steps together and abandons one that overruns, naming it', async () => {
    const seen: Array<{ name: string; overran: boolean }> = [];
    const started = Date.now();
    const reports = await runShutdownSteps(
      [
        { name: 'fast', run: () => Promise.resolve() },
        { name: 'hangs', run: () => new Promise<void>(() => undefined) },
        { name: 'slow-but-ok', run: () => new Promise<void>((r) => setTimeout(r, 50)) },
      ],
      { budgetMs: 200, log: (r) => seen.push({ name: r.name, overran: r.overran }) },
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(reports.map((r) => [r.name, r.overran])).toEqual([
      ['fast', false],
      ['hangs', true],
      ['slow-but-ok', false],
    ]);
    expect(seen).toContainEqual({ name: 'hangs', overran: true });
  });

  it('records a step that throws, synchronously or not, and carries on', async () => {
    const reports = await runShutdownSteps(
      [
        {
          name: 'sync-throw',
          run: () => {
            throw new Error('boom');
          },
        },
        { name: 'rejects', run: () => Promise.reject(new Error('nope')) },
        { name: 'ok', run: () => undefined },
      ],
      { budgetMs: 200 },
    );
    expect(reports.map((r) => r.error)).toEqual(['boom', 'nope', undefined]);
  });
});

describe('closing the pieces that wait on outside peers', () => {
  it('the control server closes with a request still open', async () => {
    const app = await buildControl({});
    app.get('/never', () => new Promise(() => undefined));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    // An MCP server's long wait for the user: the request never finishes.
    const pending = fetch(`http://127.0.0.1:${port}/never`).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(1500);
    await pending;
  });

  it('the server link closes when the server never answers the close handshake', async () => {
    vi.useRealTimers();
    // A "server" that accepts the socket and then goes silent, even to a close frame.
    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    const sockets: import('ws').WebSocket[] = [];
    wss.on('connection', (ws) => {
      sockets.push(ws);
      // Swallow the client's close frame: no reply, no teardown.
      (ws as unknown as { _socket: { pause(): void } })._socket.pause();
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
    const { port } = http.address() as AddressInfo;
    const link = createServerLink({
      url: `ws://127.0.0.1:${port}`,
      daemonKey: 'k',
      hostId: 'd1',
      logger: pino({ level: 'silent' }),
      onEvent: () => {},
    } as unknown as Parameters<typeof createServerLink>[0]);
    link.start?.();
    await vi.waitFor(() => expect(sockets.length).toBe(1), { timeout: 5000 });
    const started = Date.now();
    await link.close();
    expect(Date.now() - started).toBeLessThan(4000);
    for (const s of sockets) s.terminate();
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
  }, 15_000);
});
