// Regression: a multi-MB `view_file` image must survive the real host→server
// WebSocket. The host allows images up to 7 MB (9.5 MB as base64), but the
// socket's default frame cap is 1 MiB — the server closed the link (1009) and
// the publish request vanished, so the host sat out its timeout and the tool
// surfaced `502 view_file_publish_failed: artifact publish timed out`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { generateUserKeypair, mintDaemonKey } from '@patch/auth';
import { decode, encode, type WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { PresenceTracker } from '../src/presence.js';

describe('large artifact frames over the real host socket', () => {
  let dataDir: string;
  let url: string;
  let close: () => Promise<void>;
  let user: ReturnType<typeof generateUserKeypair>;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'patch-bigframe-'));
    user = generateUserKeypair();
    const registry = Registry.load(dataDir);
    registry.bootstrapAccount({ keypair: user });
    for (const hostId of ['daemon-1', 'daemon-2']) {
      registry.setDaemonKey({
        hostId,
        publicKey: user.publicKey,
        issuedAt: Math.floor(Date.now() / 1000),
      });
    }
    const { app } = await buildAll({ registry, presence: new PresenceTracker(), logger: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    close = async () => {
      await app.close();
    };
  });

  afterEach(async () => {
    await close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('answers a 6 MB image publish instead of dropping the socket', async () => {
    const daemonKey = await mintDaemonKey({
      userPrivateKey: user.privateKey,
      hostId: 'daemon-1',
      label: 'host',
    });
    const ws = new WebSocket(`${url}/ws`);
    const frames: WireEvent[] = [];
    let closeCode: number | undefined;
    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        frames.push(decode(Array.isArray(raw) ? Buffer.concat(raw) : (raw as Buffer)));
      } catch {
        // non-wire frame
      }
    });
    ws.on('close', (code) => {
      closeCode = code;
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.send(encode({ type: 'hello', clientType: 'host', clientVersion: '1', auth: daemonKey }));
    for (let i = 0; i < 100 && !frames.some((f) => f.type === 'auth.ok'); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }

    // Incompressible bytes, so permessage-deflate cannot shrink it under the cap.
    const bytes = Buffer.alloc(6 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 2654435761) >>> 24;
    ws.send(
      encode({
        type: 'patch.artifact.publish_request',
        requestId: 'big-1',
        chatId: 'chat-big',
        artifactId: 'abcdef0123',
        title: 'big.png',
        path: 'big.png',
        raw: { contentType: 'image/png', base64: bytes.toString('base64') },
      }),
    );

    for (
      let i = 0;
      i < 250 &&
      closeCode === undefined &&
      !frames.some((f) => f.type === 'patch.artifact.publish_response');
      i++
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(closeCode).toBeUndefined();
    const res = frames.find((f) => f.type === 'patch.artifact.publish_response');
    expect(res).toMatchObject({ requestId: 'big-1', ok: true });
    ws.close();
  });
});

describe('artifact publish reply routing', () => {
  it('answers the host that asked, not the account home machine', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'patch-reply-'));
    const user = generateUserKeypair();
    const registry = Registry.load(dataDir);
    registry.bootstrapAccount({ keypair: user });
    for (const hostId of ['daemon-1', 'daemon-2']) {
      registry.setDaemonKey({
        hostId,
        publicKey: user.publicKey,
        issuedAt: Math.floor(Date.now() / 1000),
      });
    }
    const { app } = await buildAll({ registry, presence: new PresenceTracker(), logger: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    try {
      const connect = async (hostId: string): Promise<{ ws: WebSocket; frames: WireEvent[] }> => {
        const key = await mintDaemonKey({
          userPrivateKey: user.privateKey,
          hostId,
          label: hostId,
        });
        const ws = new WebSocket(`${url}/ws`);
        const frames: WireEvent[] = [];
        ws.on('message', (raw: WebSocket.RawData) => {
          try {
            frames.push(decode(Array.isArray(raw) ? Buffer.concat(raw) : (raw as Buffer)));
          } catch {
            // non-wire frame
          }
        });
        await new Promise<void>((resolve, reject) => {
          ws.once('open', () => resolve());
          ws.once('error', reject);
        });
        ws.send(encode({ type: 'hello', clientType: 'host', clientVersion: '1', auth: key }));
        for (let i = 0; i < 100 && !frames.some((f) => f.type === 'auth.ok'); i++) {
          await new Promise((r) => setTimeout(r, 20));
        }
        return { ws, frames };
      };
      const home = await connect('daemon-1');
      const other = await connect('daemon-2');
      // The chat is unknown to the server's registry (e.g. just after a restart).
      other.ws.send(
        encode({
          type: 'patch.artifact.publish_request',
          requestId: 'r-other',
          chatId: 'chat-unknown',
          artifactId: 'abcdef0123',
          title: 'small.jpg',
          path: 'small.jpg',
          raw: { contentType: 'image/jpeg', base64: Buffer.from('jpeg').toString('base64') },
        }),
      );
      for (
        let i = 0;
        i < 100 && !other.frames.some((f) => f.type === 'patch.artifact.publish_response');
        i++
      ) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(other.frames.find((f) => f.type === 'patch.artifact.publish_response')).toMatchObject({
        requestId: 'r-other',
        ok: true,
      });
      expect(home.frames.some((f) => f.type === 'patch.artifact.publish_response')).toBe(false);
      home.ws.close();
      other.ws.close();
    } finally {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
