// The host outbox is the only way a host's transcript reaches the server
// (spec/01 § Host outbox): every event is kept on the host's disk until the
// server has committed it and acknowledged its position, across a restart of
// the host and a restart of the server. Real server, real host link, real
// outbox file.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import WebSocket from 'ws';
import { generateUserKeypair, mintDaemonKey } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { buildAll, type BuiltApp } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { createServerLink, type ServerLink } from '../../host/src/serverLink.js';
import { Outbox } from '../../host/src/outbox.js';

const silent = pino({ level: 'silent' });
const HOST_ID = 'outbox-host';
const CHAT = 'c-outbox';

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor: timed out');
}

const say = (seq: number): WireEvent =>
  ({ type: 'chat.message', chatId: CHAT, role: 'assistant', content: `m${seq}`, seq }) as WireEvent;

describe('host outbox delivery', () => {
  let dataDir: string;
  let patchHome: string;
  let daemonKey: string;
  let server: BuiltApp | null = null;
  let port = 0;
  let link: ServerLink | null = null;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'outbox-data-'));
    patchHome = mkdtempSync(join(tmpdir(), 'outbox-home-'));
    const kp = generateUserKeypair();
    const registry = Registry.load(dataDir);
    registry.bootstrapAccount({ keypair: kp });
    registry.setDaemonKey({ hostId: HOST_ID, publicKey: kp.publicKey, issuedAt: Date.now() });
    daemonKey = await mintDaemonKey({ userPrivateKey: kp.privateKey, hostId: HOST_ID, label: 't' });
  });

  afterEach(async () => {
    await link?.close();
    link = null;
    await server?.app.close();
    server = null;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(patchHome, { recursive: true, force: true });
  });

  async function startServer(): Promise<BuiltApp> {
    const built = await buildAll({
      registry: Registry.load(dataDir),
      logger: false,
      hostOfflineGraceMs: 0,
      pushBackend: { send: async () => ({ ok: true as const }) } as never,
    });
    await built.app.listen({ port, host: '127.0.0.1' });
    port = (built.app.server.address() as AddressInfo).port;
    server = built;
    return built;
  }

  /** A host process: its outbox is read back from disk each time one starts. */
  function startHost(): { link: ServerLink; outbox: Outbox } {
    const outbox = new Outbox({ path: join(patchHome, 'outbox.jsonl'), logger: silent });
    const l = createServerLink({
      url: `ws://127.0.0.1:${port}/ws`,
      daemonKey,
      clientVersion: '0.0.0-test',
      logger: silent,
      outbox,
      backoffSchedule: [20],
      onAuthed: (send) =>
        send({ type: 'chat.spawned', hostId: HOST_ID, chatId: CHAT, folder: '/w' }),
    });
    link = l;
    return { link: l, outbox };
  }

  const recorded = (built: BuiltApp): number[] =>
    built.chatLogStore.read(CHAT, -1).map((e) => (e as { seq: number }).seq);

  it('keeps what a host logged while offline across a host restart, and delivers it once', async () => {
    const built = await startServer();
    // The host logs three events and stops before it ever reaches the server.
    const first = startHost();
    for (const seq of [0, 1, 2]) first.link.send(say(seq));
    expect(first.outbox.pending()).toHaveLength(3);
    await first.link.close();

    // The restarted host reads them back and delivers them.
    const second = startHost();
    expect(second.outbox.pending().map((p) => p.position)).toEqual([0, 1, 2]);
    second.link.start();
    await waitFor(() => second.outbox.pending().length === 0);
    expect(recorded(built)).toEqual([0, 1, 2]);
    // Acknowledged on the host's disk too: a third start owes nothing.
    await second.link.close();
    expect(startHost().outbox.pending()).toEqual([]);
  });

  it('keeps what a host logged while the server was down, and delivers it when the server is back', async () => {
    await startServer();
    const host = startHost();
    host.link.start();
    await waitFor(() => host.link.isOnline());
    host.link.send(say(0));
    await waitFor(() => host.outbox.pending().length === 0);

    await server!.app.close();
    server = null;
    await waitFor(() => !host.link.isOnline());
    host.link.send(say(1));
    host.link.send(say(2));
    expect(host.outbox.pending().map((p) => p.event)).toEqual([say(1), say(2)]);

    const back = await startServer();
    await waitFor(() => host.outbox.pending().length === 0);
    expect(recorded(back)).toEqual([0, 1, 2]);
  });

  it('a resend of what the server committed before it restarted is kept once, and acknowledged', async () => {
    await startServer();
    const host = startHost();
    host.link.start();
    await waitFor(() => host.link.isOnline());
    host.link.send(say(0));
    host.link.send(say(1));
    await waitFor(() => host.outbox.pending().length === 0);
    await host.link.close();
    await server!.app.close();
    server = null;

    // The host never heard the acknowledgement: its outbox still owes both.
    const box = join(patchHome, 'outbox.jsonl');
    const lines = readFileSync(box, 'utf8')
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith('{"ack"'));
    rmSync(box);
    const replay = new Outbox({ path: box, logger: silent });
    for (const line of lines) replay.append((JSON.parse(line) as { e: WireEvent }).e);

    const back = await startServer();
    const again = startHost();
    expect(again.outbox.pending()).toHaveLength(2);
    again.link.start();
    await waitFor(() => again.outbox.pending().length === 0);
    expect(recorded(back)).toEqual([0, 1]);
  });

  it('refuses a transcript event sent outside the outbox', async () => {
    const built = await startServer();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));
    ws.send(
      JSON.stringify({
        type: 'hello',
        clientType: 'host',
        clientVersion: '0.0.0-test',
        auth: daemonKey,
      }),
    );
    await waitFor(() => built.hostLink.status() === 'online');
    ws.send(JSON.stringify({ type: 'chat.spawned', hostId: HOST_ID, chatId: CHAT, folder: '/w' }));
    ws.send(JSON.stringify(say(0)));
    await new Promise((r) => setTimeout(r, 200));
    expect(built.chatLogStore.has(CHAT)).toBe(false);
    ws.close();
  });
});
