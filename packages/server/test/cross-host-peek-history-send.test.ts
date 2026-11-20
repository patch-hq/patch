// Cross-host `patch_send_to` / `patch_stop` (spec/03 § Cross-chat tools,
// spec/06 § Cross-chat toolset). These tools take only a chatId, never a host,
// so the server resolves the owning host from the chat mirror and relays
// there, the same way it already does for `patch.spawn`. (`patch_peek` and
// `patch_history` are answered by the server itself: `agent-reads.test.ts`.)

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { registerCrossHostBridge } from '../src/cross-host.js';
import type { HostLink } from '../src/host-link.js';
import type { ChatRegistry } from '../src/chat-registry.js';
import type { Registry } from '../src/registry.js';

const logger = pino({ level: 'silent' });

interface Sent {
  hostId: string;
  surfaceId: string;
  event: WireEvent;
}

function harness(opts: { owners?: Record<string, string>; online?: string[] } = {}) {
  const owners = opts.owners ?? { 'chat-remote': 'host-b' };
  const online = new Set(opts.online ?? ['host-a', 'host-b']);
  const sent: Sent[] = [];
  let handler: ((e: WireEvent, from: string | null) => void) | undefined;

  const hostLink = {
    sendTo: (hostId: string, surfaceId: string, event: WireEvent) => {
      sent.push({ hostId, surfaceId, event });
    },
    isOnline: (id: string) => online.has(id),
    onEvent: (h: (e: WireEvent, from: string | null) => void) => {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
  } as unknown as HostLink;

  const chatRegistry = {
    list: () => [],
    get: (chatId: string) => {
      const hostId = owners[chatId];
      return hostId ? { chatId, hostId } : undefined;
    },
  } as unknown as ChatRegistry;
  const registry = { isRegisteredHost: () => true } as unknown as Registry;

  const dispose = registerCrossHostBridge({ logger, hostLink, chatRegistry, registry });
  return {
    sent,
    dispose,
    feed: (event: WireEvent, from: string | null) => handler?.(event, from),
  };
}

describe('cross-host patch.send_to — relayed and acknowledged', () => {
  it('relays to the owning host, carrying the requestId', () => {
    const h = harness();
    h.feed(
      {
        type: 'patch.send_to',
        sourceChatId: 'chat-src',
        targetChatId: 'chat-remote',
        message: 'do the thing',
        requestId: 'req-3',
      } as WireEvent,
      'host-a',
    );
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.hostId).toBe('host-b');
    expect(h.sent[0]!.event).toMatchObject({ type: 'patch.send_to', requestId: 'req-3' });
    h.dispose();
  });

  it("routes the owning host's ack back to the caller", () => {
    const h = harness();
    h.feed(
      {
        type: 'patch.send_to',
        sourceChatId: 'chat-src',
        targetChatId: 'chat-remote',
        message: 'do the thing',
        requestId: 'req-3',
      } as WireEvent,
      'host-a',
    );
    h.sent.length = 0;
    h.feed(
      {
        type: 'patch.send_to.response',
        requestId: 'req-3',
        sourceChatId: 'chat-src',
        targetChatId: 'chat-remote',
        ok: true,
      } as WireEvent,
      'host-b',
    );
    expect(h.sent).toEqual([
      {
        hostId: 'host-a',
        surfaceId: 'cross-host-bridge',
        event: {
          type: 'patch.send_to.response',
          requestId: 'req-3',
          sourceChatId: 'chat-src',
          targetChatId: 'chat-remote',
          ok: true,
        },
      },
    ]);
    h.dispose();
  });

  it('does not relay a same-host / surface send with no requestId', () => {
    const h = harness();
    h.feed(
      {
        type: 'patch.send_to',
        sourceChatId: 'chat-src',
        targetChatId: 'chat-local',
        message: 'hi',
      } as WireEvent,
      'host-a',
    );
    expect(h.sent).toHaveLength(0);
    h.dispose();
  });

  it('refuses a chat_not_found target with an error the caller can act on', () => {
    const h = harness({ owners: {} });
    h.feed(
      {
        type: 'patch.send_to',
        sourceChatId: 'chat-src',
        targetChatId: 'chat-ghost',
        message: 'hi',
        requestId: 'req-3',
      } as WireEvent,
      'host-a',
    );
    const resp = h.sent.find((s) => s.event.type === 'patch.send_to.response');
    expect(resp?.event).toMatchObject({ ok: false, error: { code: 'chat_not_found' } });
    const chatError = h.sent.find((s) => s.event.type === 'chat.error');
    expect(chatError).toBeDefined();
    h.dispose();
  });
});

describe('cross-host patch.stop — relayed to the owning host', () => {
  it('relays a requestId-carrying stop to the owner and routes its answer back', () => {
    const h = harness();
    h.feed(
      {
        type: 'patch.stop',
        sourceChatId: 'chat-src',
        targetChatId: 'chat-remote',
        requestId: 'req-4',
      } as WireEvent,
      'host-a',
    );
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.hostId).toBe('host-b');
    expect(h.sent[0]!.event).toMatchObject({ type: 'patch.stop', requestId: 'req-4' });
    h.feed(
      {
        type: 'patch.stop.response',
        requestId: 'req-4',
        sourceChatId: 'chat-src',
        targetChatId: 'chat-remote',
        ok: true,
      } as WireEvent,
      'host-b',
    );
    expect(h.sent[1]!.hostId).toBe('host-a');
    expect(h.sent[1]!.event).toMatchObject({ type: 'patch.stop.response', ok: true });
    h.dispose();
  });

  it('does not relay a stop without a requestId (same-host audit record)', () => {
    const h = harness();
    h.feed(
      { type: 'patch.stop', sourceChatId: 'chat-src', targetChatId: 'chat-remote' } as WireEvent,
      'host-a',
    );
    expect(h.sent).toHaveLength(0);
    h.dispose();
  });

  it('refuses an unknown chat with a response the caller can act on', () => {
    const h = harness({ owners: {} });
    h.feed(
      {
        type: 'patch.stop',
        sourceChatId: 'chat-src',
        targetChatId: 'chat-ghost',
        requestId: 'req-5',
      } as WireEvent,
      'host-a',
    );
    const resp = h.sent.find((s) => s.event.type === 'patch.stop.response');
    expect(resp?.event).toMatchObject({ ok: false, error: { code: 'chat_not_found' } });
    h.dispose();
  });
});
