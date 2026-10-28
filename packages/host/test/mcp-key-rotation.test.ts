// The host rotates its local key on every start, but a chat's patch-tools
// child outlives a host restart. The child must follow the key file, not the
// value it was launched with, or every call is refused with 401 "bad key".

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Daemon } from '../src/chatRunner.js';
import { buildControl } from '../src/control.js';
import { MemoryJobsStore } from '../src/jobs-interface.js';
import { createMetaStore } from '../src/meta.js';
import { buildPatchToolsServer } from '../src/mcp.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

async function startHost(home: string, socketPath: string, localKey: string) {
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: createMockSdkBackend(),
    oauthAccessToken: 'tok',
    emit: () => undefined,
    logger: silent,
  });
  const app = await buildControl({ localKey, daemon, jobs: new MemoryJobsStore() });
  await app.listen({ path: socketPath });
  return app;
}

describe('patch-tools child across a host restart', () => {
  it('keeps working after the host mints a new key into the key file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-keyrot-'));
    const socketPath = join(home, 'daemon.sock');
    const keyFile = join(home, 'local.key');
    writeFileSync(keyFile, 'key-one');

    let app = await startHost(home, socketPath, 'key-one');
    const server = buildPatchToolsServer({
      hostSocketPath: socketPath,
      chatId: 'caller-1',
      localKey: () => readFileSync(keyFile, 'utf8').trim(),
    });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const first = await client.callTool({ name: 'patch_list_chats', arguments: {} });
    expect(first.isError).toBeFalsy();

    await app.close();
    writeFileSync(keyFile, 'key-two');
    app = await startHost(home, socketPath, 'key-two');

    const second = await client.callTool({ name: 'patch_list_chats', arguments: {} });
    expect(second.isError).toBeFalsy();

    await client.close();
    await app.close();
  });
});
