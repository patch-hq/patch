// patch_peek / patch_history read from the server; patch_send_to and
// `patch chats get` fall back to the owning host or the server when the chat
// is not local (spec/03 § Cross-chat tools, spec/06 § Cross-chat toolset).
// `peekFromServer`/`historyFromServer`/`sendToRemoteChat` are the injectable
// hooks production wires to the host's server link (index.ts); this file
// exercises the UDS endpoint's use of them directly.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { buildControl, type BuildOptions } from '../src/control.js';
import { MemoryJobsStore } from '../src/jobs-interface.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { RemoteRelayError } from '../src/remote-relay.js';

const LOCAL_KEY = 'local-secret';
const silent = pino({ level: 'silent' });

function setup(remote: Partial<BuildOptions> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-relay-'));
  const sdk = createMockSdkBackend();
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: sdk,
    oauthAccessToken: 'x',
    emit: () => {},
    logger: silent,
    now: () => 1_700_000_000_000,
  });
  const jobs = new MemoryJobsStore({ now: () => 1_700_000_000_000 });
  return { daemon, jobs, ...remote };
}

describe('patch_peek — read from the server, whichever host owns the chat', () => {
  it('calls peekFromServer with the caller + target + limit, and returns its result verbatim', async () => {
    const calls: unknown[] = [];
    const logged: unknown[] = [];
    const serverResult = {
      chat_state: { chatId: 'chat-on-host-b', chatStatus: { state: 'idle' } },
      events: [{ type: 'chat.message' }],
      truncated: false,
    };
    const { daemon, jobs } = setup();
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      peekFromServer: async (req) => {
        calls.push(req);
        return serverResult;
      },
      toolLogger: (entry) => logged.push(entry),
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/peek/chat-on-host-b?limit=10&callerChatId=mgr',
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(serverResult);
      expect(calls).toEqual([{ sourceChatId: 'mgr', targetChatId: 'chat-on-host-b', limit: 10 }]);
      expect(logged).toMatchObject([
        { tool: 'patch_peek', callerChatId: 'mgr', targetChatId: 'chat-on-host-b', ok: true },
      ]);
    } finally {
      await app.close();
    }
  });

  it('asks the server even when the chat is this host’s own', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'patch-relay-folder-'));
    mkdirSync(folder, { recursive: true });
    const { daemon, jobs } = setup();
    const chatId = await daemon.spawnChat({ folder, prompt: 'hi' });
    const asked: string[] = [];
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      peekFromServer: async (req) => {
        asked.push(req.targetChatId);
        return { chat_state: { chatId }, events: [], truncated: false };
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/internal/peek/${chatId}?callerChatId=mgr`,
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(res.statusCode).toBe(200);
      expect(asked).toEqual([chatId]);
    } finally {
      await app.close();
    }
  });

  it('a chat_not_found from the server surfaces as a 404, not a 502', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      peekFromServer: async () => {
        throw new RemoteRelayError('chat_not_found', 'no such chat: chat-ghost');
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/peek/chat-ghost?callerChatId=mgr',
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'chat_not_found' });
    } finally {
      await app.close();
    }
  });

  it('a server that cannot be reached surfaces as a 502 naming the reason', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      peekFromServer: async () => {
        throw new RemoteRelayError('host_not_registered', 'the link to the Patch server is down');
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/peek/chat-on-host-b?callerChatId=mgr',
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().message).toContain('Patch server');
    } finally {
      await app.close();
    }
  });

  it('with no callerChatId (the CLI) still reads from the server', async () => {
    const { daemon, jobs } = setup();
    const calls: unknown[] = [];
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      peekFromServer: async (req) => {
        calls.push(req);
        return { chat_state: {}, events: [], truncated: false };
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/peek/chat-on-host-b',
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(res.statusCode).toBe(200);
      expect(calls).toEqual([{ sourceChatId: 'cli', targetChatId: 'chat-on-host-b', limit: 50 }]);
    } finally {
      await app.close();
    }
  });

  it('with no server to read from, answers 503', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({ localKey: LOCAL_KEY, daemon, jobs });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/peek/x',
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
});

describe('patch_history — read from the server, whichever host owns the chat', () => {
  it('calls historyFromServer and returns its result verbatim', async () => {
    const { daemon, jobs } = setup();
    const serverResult = {
      events: [{ type: 'chat.message' } as unknown as WireEvent],
      nextFromSeq: 5,
    };
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      historyFromServer: async (req) => {
        expect(req).toEqual({
          sourceChatId: 'mgr',
          targetChatId: 'chat-on-host-b',
          fromSeq: 2,
          limit: 20,
        });
        return serverResult;
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/history/chat-on-host-b?fromSeq=2&limit=20&callerChatId=mgr',
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(serverResult);
    } finally {
      await app.close();
    }
  });

  it('clamps a huge limit to 200 rather than refusing', async () => {
    const { daemon, jobs } = setup();
    let asked: number | undefined;
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      historyFromServer: async (req) => {
        asked = req.limit;
        return { events: [] };
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/history/c?limit=5000&callerChatId=mgr',
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(res.statusCode).toBe(200);
      expect(asked).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('a chat_not_found from the server surfaces as a 404', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      historyFromServer: async () => {
        throw new RemoteRelayError('chat_not_found', 'no such chat: chat-ghost');
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/history/chat-ghost?callerChatId=mgr',
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('rejects a malformed query', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      historyFromServer: async () => ({ events: [] }),
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/history/c?fromSeq=-1',
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe('patch_send_to — falls back to the owning host when not local', () => {
  it('calls sendToRemoteChat and reports queued on success', async () => {
    const { daemon, jobs } = setup();
    let called: unknown;
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      sendToRemoteChat: async (req) => {
        called = req;
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/send-to',
        headers: { authorization: `Bearer ${LOCAL_KEY}`, 'content-type': 'application/json' },
        payload: { chatId: 'chat-on-host-b', message: 'hi', callerChatId: 'mgr' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, queued: true });
      expect(called).toEqual({
        sourceChatId: 'mgr',
        targetChatId: 'chat-on-host-b',
        message: '[from chat mgr] hi',
        // The id it is delivered under there, so its reply can be found by it.
        localId: expect.any(String),
        revealTarget: true,
      });
    } finally {
      await app.close();
    }
  });

  it('a chat_not_found from the remote relay surfaces as a 404', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      sendToRemoteChat: async () => {
        throw new RemoteRelayError('chat_not_found', 'no such chat: chat-ghost');
      },
    });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/send-to',
        headers: { authorization: `Bearer ${LOCAL_KEY}`, 'content-type': 'application/json' },
        payload: { chatId: 'chat-ghost', message: 'hi', callerChatId: 'mgr' },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('GET /chats/:id (patch chats get) — falls back to the owning host when not local', () => {
  it('relays a peek of one event and returns the remote chat_state', async () => {
    const { daemon, jobs } = setup();
    const calls: unknown[] = [];
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      peekFromServer: async (req) => {
        calls.push(req);
        return {
          chat_state: { chatId: 'chat-on-host-b', chatStatus: { state: 'idle' } },
          events: [],
          truncated: false,
        };
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/chats/chat-on-host-b',
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ chatId: 'chat-on-host-b', chatStatus: { state: 'idle' } });
      expect(calls).toEqual([{ sourceChatId: 'cli', targetChatId: 'chat-on-host-b', limit: 1 }]);
    } finally {
      await app.close();
    }
  });

  it('a chat_not_found from the relay is a 404', async () => {
    const { daemon, jobs } = setup();
    const app = await buildControl({
      localKey: LOCAL_KEY,
      daemon,
      jobs,
      peekFromServer: async () => {
        throw new RemoteRelayError('chat_not_found', 'no such chat');
      },
    });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/chats/chat-ghost',
        headers: { authorization: `Bearer ${LOCAL_KEY}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
