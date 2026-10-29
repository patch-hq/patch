// A question card answered on a chat that lives on a host OTHER than the
// server's first (manager) host. The surface greys the card the instant it
// is tapped, so the only proof the agent heard is the blocked tool call
// actually resuming with the user's answers. This drives the real chain end to
// end: surface -> server hub -> InboundHostLink -> the chat's own host socket ->
// the host's real frame handler -> the SDK permission gate -> echo back.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { generateUserKeypair, mintSurfaceCredential, mintDaemonKey } from '@patch/auth';
import { WireTestClient } from '@patch/wire/test-client';
import type { WireEvent } from '@patch/wire';
import { buildAll, type BuiltApp } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { Daemon } from '../../host/src/chatRunner.js';
import { createMetaStore } from '../../host/src/meta.js';
import { createMockSdkBackend } from '../../host/src/sdkBackend.js';
import { createServerLink, type ServerLink } from '../../host/src/serverLink.js';
import { handleServerEvent } from '../../host/src/index.js';

const silent = pino({ level: 'silent' });

async function waitFor(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor: timed out');
}

interface Host {
  daemon: Daemon;
  link: ServerLink;
  received: WireEvent[];
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function twoMachines() {
  const dataDir = mkdtempSync(join(tmpdir(), 'perm-remote-data-'));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const kp = generateUserKeypair();
  const registry = Registry.load(dataDir);
  registry.bootstrapAccount({ keypair: kp });
  registry.setDaemonKey({ hostId: 'home', publicKey: kp.publicKey, issuedAt: Date.now() });
  registry.setDaemonKey({ hostId: 'remote', publicKey: kp.publicKey, issuedAt: Date.now() });
  const built: BuiltApp = await buildAll({
    registry,
    logger: false,
    hostOfflineGraceMs: 0,
    pushBackend: { send: async () => ({ ok: true as const }) } as never,
  });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  cleanups.push(() => built.app.close());
  const wsUrl = `ws://127.0.0.1:${(built.app.server.address() as AddressInfo).port}/ws`;

  async function startMachine(hostId: string): Promise<Host> {
    const home = mkdtempSync(join(tmpdir(), `perm-remote-${hostId}-`));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const received: WireEvent[] = [];
    let link!: ServerLink;
    const daemon = new Daemon({
      hostId,
      metaStore: createMetaStore(home),
      sdkBackend: createMockSdkBackend(),
      oauthAccessToken: 'mock-token',
      emit: (e) => link.send(e),
      logger: silent,
    });
    daemon.hydrate();
    const daemonKey = await mintDaemonKey({ userPrivateKey: kp.privateKey, hostId, label: hostId });
    link = createServerLink({
      url: wsUrl,
      daemonKey,
      clientVersion: '0.0.0-test',
      logger: silent,
      backoffSchedule: [20, 20, 20],
      enableTestHooks: true,
      onAuthed: (sender) => {
        for (const state of daemon.list()) {
          sender({ type: 'chat.spawned', hostId, chatId: state.chatId, folder: state.folder });
        }
      },
      onFrame: (event, sender) => {
        received.push(event);
        void handleServerEvent(event, daemon, sender, silent);
      },
    });
    link.start();
    cleanups.push(async () => {
      daemon.shutdown();
      await link.close();
    });
    await waitFor(() => link.isOnline());
    return { daemon, link, received };
  }

  // Home registers first, so it is the manager host: the wrong place to
  // send an answer for a chat that is not its own.
  const home = await startMachine('home');
  const remote = await startMachine('remote');
  await waitFor(() => registry.registeredHostIds().length === 2);

  const folder = mkdtempSync(join(tmpdir(), 'perm-remote-folder-'));
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
  const cred = await mintSurfaceCredential({
    userPrivateKey: kp.privateKey,
    surfaceId: 'srf-1',
    surfaceKind: 'web',
    label: 'perm',
  });
  const surface = new WireTestClient({ url: wsUrl, clientType: 'surface-cli', auth: cred });
  cleanups.push(() => surface.close().catch(() => undefined));
  const authed = surface.waitFor('auth.ok');
  await surface.connect();
  await authed;

  const spawned = surface.waitFor('chat.spawned');
  surface.send({ type: 'chat.spawn_request', hostId: 'remote', folder });
  const chatId = (await spawned).chatId;
  surface.send({ type: 'chat.focus_change', chatId });
  await waitFor(() => remote.daemon.list().some((c) => c.chatId === chatId));

  type Outcome = { approve: boolean; updatedInput?: Record<string, unknown> };
  /** The agent on the remote host asks a question and blocks on it. */
  async function ask(): Promise<{ requestId: string; outcome: Promise<Outcome> }> {
    const asked = surface.waitFor('chat.permission_request', (e) => e.chatId === chatId);
    const outcome = (
      remote.daemon as unknown as {
        requestPermission: (
          chatId: string,
          tool: string,
          args: Record<string, unknown>,
          description?: string,
        ) => Promise<Outcome>;
      }
    ).requestPermission(
      chatId,
      'AskUserQuestion',
      { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] },
      'ask',
    );
    return { requestId: (await asked).requestId, outcome };
  }

  return {
    home,
    remote,
    surface,
    chatId,
    ask,
    registryOnline: (hostId: string) => built.hostLink.isOnline(hostId),
  };
}

const within = <T>(p: Promise<T>, ms: number, msg: string): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

describe('answering a question card on a chat that lives on a remote host', () => {
  it('reaches that host, unblocks the agent with the answers, and echoes back', async () => {
    const t = await twoMachines();
    const { requestId, outcome } = await t.ask();
    const echoed = t.surface.waitFor('chat.permission_response', (e) => e.requestId === requestId);
    t.surface.send({
      type: 'chat.permission_response',
      chatId: t.chatId,
      requestId,
      approve: true,
      decision: 'approve_with_edits',
      editedNewString: JSON.stringify({ 'Which?': 'B' }),
    } as never);

    const result = await within(outcome, 3000, 'agent never received the answer');
    expect(result.approve).toBe(true);
    expect(result.updatedInput?.['answers']).toEqual({ 'Which?': 'B' });
    expect((await echoed).approve).toBe(true);
    expect(t.remote.received.some((e) => e.type === 'chat.permission_response')).toBe(true);
    expect(t.home.received.some((e) => e.type === 'chat.permission_response')).toBe(false);
  });

  it("is delivered once the chat's host is back when it was unreachable at the moment of the answer", async () => {
    const t = await twoMachines();
    const { requestId, outcome } = await t.ask();
    t.remote.link.severForTest();
    await waitFor(() => !t.registryOnline('remote'));
    t.surface.send({
      type: 'chat.permission_response',
      chatId: t.chatId,
      requestId,
      approve: true,
      decision: 'approve_with_edits',
      editedNewString: JSON.stringify({ 'Which?': 'A' }),
    } as never);
    const result = await within(outcome, 4000, 'agent never received the answer after reconnect');
    expect(result.updatedInput?.['answers']).toEqual({ 'Which?': 'A' });
  });
});
