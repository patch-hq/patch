// The MCP child's UDS shim (`udsRequest`) and its stdio server. We exercise
// the network round-trip from the MCP-child side without involving the full
// McpServer transport (that is tested upstream by the MCP SDK).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { udsRequest, runPatchToolsServerStdio } from '../src/mcp.js';

// The socket is gated as a whole (spec/02 § Control IPC): the MCP child
// presents the host's local key as a Bearer on every call.
const LOCAL_KEY = 'local-secret';

describe('udsRequest — raw UDS transport edge cases', () => {
  it('resolves undefined for a 200 with an empty body', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-mcp-uds-'));
    const socketPath = join(home, 'raw.sock');
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const result = await udsRequest(socketPath, { method: 'GET', path: '/anything' });
      expect(result).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects with a clear message for a 200 with malformed JSON', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-mcp-uds-'));
    const socketPath = join(home, 'raw.sock');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{not valid json');
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      await expect(udsRequest(socketPath, { method: 'GET', path: '/anything' })).rejects.toThrow(
        /bad JSON from host/,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('runPatchToolsServerStdio', () => {
  const savedEnv: Record<string, string | undefined> = {
    PATCH_CHAT_ID: process.env['PATCH_CHAT_ID'],
    PATCH_DAEMON_SOCKET: process.env['PATCH_DAEMON_SOCKET'],
    PATCH_DAEMON_LOCAL_KEY: process.env['PATCH_DAEMON_LOCAL_KEY'],
  };

  beforeEach(() => {
    // The host always sets this for the children it starts; the individual
    // cases below override it to assert the missing-var failures.
    process.env['PATCH_DAEMON_LOCAL_KEY'] = LOCAL_KEY;
  });
  afterEach(() => {
    if (savedEnv['PATCH_DAEMON_LOCAL_KEY'] === undefined)
      delete process.env['PATCH_DAEMON_LOCAL_KEY'];
    else process.env['PATCH_DAEMON_LOCAL_KEY'] = savedEnv['PATCH_DAEMON_LOCAL_KEY'];
  });

  // A child with no key was not started by a host, and every call it made
  // would be refused. Failing here puts the reason where it is legible.
  it('throws when PATCH_DAEMON_LOCAL_KEY is missing (NO FALLBACK)', async () => {
    process.env['PATCH_CHAT_ID'] = 'some-chat';
    process.env['PATCH_DAEMON_SOCKET'] = '/tmp/does-not-matter.sock';
    delete process.env['PATCH_DAEMON_LOCAL_KEY'];
    await expect(runPatchToolsServerStdio()).rejects.toThrow(/PATCH_DAEMON_LOCAL_KEY/);
  });

  it('throws when PATCH_CHAT_ID is missing (NO FALLBACK)', async () => {
    delete process.env['PATCH_CHAT_ID'];
    process.env['PATCH_DAEMON_SOCKET'] = '/tmp/does-not-matter.sock';
    try {
      await expect(runPatchToolsServerStdio()).rejects.toThrow(/PATCH_CHAT_ID/);
    } finally {
      if (savedEnv['PATCH_CHAT_ID'] === undefined) delete process.env['PATCH_CHAT_ID'];
      else process.env['PATCH_CHAT_ID'] = savedEnv['PATCH_CHAT_ID'];
      if (savedEnv['PATCH_DAEMON_SOCKET'] === undefined) delete process.env['PATCH_DAEMON_SOCKET'];
      else process.env['PATCH_DAEMON_SOCKET'] = savedEnv['PATCH_DAEMON_SOCKET'];
    }
  });

  it('throws when the host socket env is missing (NO FALLBACK)', async () => {
    process.env['PATCH_CHAT_ID'] = 'some-chat';
    delete process.env['PATCH_DAEMON_SOCKET'];
    try {
      await expect(runPatchToolsServerStdio()).rejects.toThrow(/PATCH_HOST_SOCKET/);
    } finally {
      if (savedEnv['PATCH_CHAT_ID'] === undefined) delete process.env['PATCH_CHAT_ID'];
      else process.env['PATCH_CHAT_ID'] = savedEnv['PATCH_CHAT_ID'];
      if (savedEnv['PATCH_DAEMON_SOCKET'] === undefined) delete process.env['PATCH_DAEMON_SOCKET'];
      else process.env['PATCH_DAEMON_SOCKET'] = savedEnv['PATCH_DAEMON_SOCKET'];
    }
  });

  it('builds the server and connects a stdio transport when both env vars are set', async () => {
    // Mock ONLY the stdio transport's `start`/`close`/send plumbing — real
    // stdin/stdout in a test process is not a pipe we want a live MCP server
    // parked on. `server.connect(transport)` just calls `transport.start()`
    // and wires message handlers; it does not block waiting for input, so a
    // minimal stub that resolves immediately is enough to prove the wiring
    // (env parsing -> buildPatchToolsServer -> new StdioServerTransport ->
    // server.connect) runs end-to-end without touching real process streams.
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const startSpy = vi
      .spyOn(StdioServerTransport.prototype, 'start')
      .mockImplementation(async () => undefined);
    const closeSpy = vi
      .spyOn(StdioServerTransport.prototype, 'close')
      .mockImplementation(async () => undefined);
    process.env['PATCH_CHAT_ID'] = 'chat-stdio-test';
    // The server asks the host for the user's tool-description edits as it starts.
    const home = mkdtempSync(join(tmpdir(), 'patch-mcp-stdio-'));
    const socketPath = join(home, 'host.sock');
    const seen: string[] = [];
    const host = createServer((req, res) => {
      seen.push(`${req.method ?? ''} ${req.url ?? ''}`);
      res.setHeader('content-type', 'application/json');
      res.end('{}');
    });
    await new Promise<void>((resolve) => host.listen(socketPath, resolve));
    process.env['PATCH_DAEMON_SOCKET'] = socketPath;
    try {
      await runPatchToolsServerStdio();
      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(seen).toEqual(['GET /internal/tool-prompts']);
    } finally {
      await new Promise<void>((resolve) => host.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
      startSpy.mockRestore();
      closeSpy.mockRestore();
      if (savedEnv['PATCH_CHAT_ID'] === undefined) delete process.env['PATCH_CHAT_ID'];
      else process.env['PATCH_CHAT_ID'] = savedEnv['PATCH_CHAT_ID'];
      if (savedEnv['PATCH_DAEMON_SOCKET'] === undefined) delete process.env['PATCH_DAEMON_SOCKET'];
      else process.env['PATCH_DAEMON_SOCKET'] = savedEnv['PATCH_DAEMON_SOCKET'];
    }
  });
});
