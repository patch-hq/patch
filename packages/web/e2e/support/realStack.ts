// A REAL server and host for the browser layer, with the real web app served
// against them (spec/19-testing.md § Load targets). The other specs here run the
// component harness with no backend; the load targets cannot — they assert on
// what the real client does with what a real server sends, and on how long it
// takes. The only substitute is the agent backend (the server test harness's
// mock), exactly as in the server's own e2e suite.
//
// The web app is served by its own vite dev server, started here on a port of
// its own and proxied to the server, so nothing is shared with the harness
// vite the other specs use.

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WireEvent } from '@patch/wire';
import { startHarness, type E2EHarness } from '../../../server/test/e2e/harness.js';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((res, rej) => {
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', res);
  });
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((res) => srv.close(() => res()));
  return port;
}

export interface RealStack {
  harness: E2EHarness;
  /** http://127.0.0.1:<port> — the real web app, proxied to the real server. */
  appUrl: string;
  /** A fresh surface credential for a browser (one per device). */
  credential(surfaceId: string): Promise<string>;
  /** Make the chat the server's record holds, with `count` assistant entries `e0`..`e<count-1>`. */
  seedChat(chatId: string, count: number, name?: string): Promise<void>;
  /** Entries the host reports from `fromSeq` on, as a running turn would. */
  say(chatId: string, fromSeq: number, count: number): void;
  close(): Promise<void>;
}

export const entryText = (seq: number): string => `entry-${String(seq).padStart(6, '0')}`;

export async function startRealStack(): Promise<RealStack> {
  const harness = await startHarness();
  const port = await freePort();
  const vite: ChildProcess = spawn(
    'npx',
    ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: WEB_ROOT,
      env: { ...process.env, PATCH_API_PROXY: harness.httpBase },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '';
  vite.stdout?.on('data', (d: Buffer) => (log += d.toString()));
  vite.stderr?.on('data', (d: Buffer) => (log += d.toString()));
  const appUrl = `http://127.0.0.1:${port}`;
  const started = Date.now();
  for (;;) {
    if (vite.exitCode !== null) throw new Error(`realStack: vite exited early\n${log}`);
    try {
      const r = await fetch(`${appUrl}/app/`);
      if (r.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() - started > 60_000) throw new Error(`realStack: vite never came up\n${log}`);
    await new Promise((r) => setTimeout(r, 200));
  }

  const message = (chatId: string, seq: number): WireEvent =>
    ({
      type: 'chat.message',
      chatId,
      role: 'assistant',
      content: entryText(seq),
      seq,
    }) as WireEvent;

  return {
    harness,
    appUrl,
    credential: (surfaceId) => harness.mintSurface(surfaceId),
    async seedChat(chatId, count, name = chatId) {
      harness.link.send({
        type: 'chat.spawned',
        chatId,
        hostId: harness.hostId,
        folder: harness.folder,
      } as WireEvent);
      harness.link.send({
        type: 'chat.state',
        chatId,
        permissionMode: 'bypassPermissions',
        activity: 'idle',
        lastUpdated: Date.now(),
        pinned: false,
        pinnedAt: null,
        status: 'active',
        name,
        preview: '',
        folder: harness.folder,
      } as WireEvent);
      for (let seq = 0; seq < count; seq++) harness.link.send(message(chatId, seq));
      // The server has committed the last entry once a surface can read it.
      const probe = await harness.connectSurface(`seed-probe-${chatId}`);
      try {
        probe.send({ type: 'chat.history_request', requestId: 'seed', chatId, limit: 1 } as never);
        const deadline = Date.now() + 60_000;
        for (;;) {
          const page = await probe.waitFor('chat.history', undefined, 5000);
          const last = (page.entries.at(-1) as { seq?: number } | undefined)?.seq;
          if (last === count - 1) break;
          if (Date.now() > deadline) throw new Error(`seedChat: server stopped at seq ${last}`);
          probe.send({
            type: 'chat.history_request',
            requestId: 'seed',
            chatId,
            limit: 1,
          } as never);
          await new Promise((r) => setTimeout(r, 100));
        }
      } finally {
        await probe.close();
      }
    },
    say(chatId, fromSeq, count) {
      for (let i = 0; i < count; i++) harness.link.send(message(chatId, fromSeq + i));
    },
    async close() {
      vite.kill('SIGTERM');
      await harness.close();
    },
  };
}
