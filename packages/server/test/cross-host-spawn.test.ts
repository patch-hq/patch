// The cross-host `patch.spawn` round trip (spec/03 § Cross-chat tools).
//
// The defect this file locks down: the bridge relayed `patch.spawn` and then
// carried NOTHING back, so a target host that refused the spawn (no model
// catalogue, unknown folder) left the calling agent's tool call reporting
// success for a chat that was never created. Every case below asserts the
// outcome reaches the CALLING host.

import { describe, it, expect, vi } from 'vitest';
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

function harness(opts: { registered?: string[]; online?: string[] } = {}) {
  const registered = new Set(opts.registered ?? ['host-a', 'host-b']);
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

  const chatRegistry = { list: () => [] } as unknown as ChatRegistry;
  const registry = {
    isRegisteredHost: (id: string) => registered.has(id),
  } as unknown as Registry;

  const dispose = registerCrossHostBridge({ logger, hostLink, chatRegistry, registry });
  return {
    sent,
    dispose,
    feed: (event: WireEvent, from: string | null) => handler?.(event, from),
  };
}

const spawnFrame = (over: Partial<Record<string, unknown>> = {}): WireEvent =>
  ({
    type: 'patch.spawn',
    sourceChatId: 'chat-src',
    hostId: 'host-b',
    folder: '/work/qa',
    prompt: 'hi',
    requestId: 'req-1',
    ...over,
  }) as WireEvent;

describe('cross-host patch.spawn — the answer comes back', () => {
  it('relays the request to the named host, carrying the requestId', () => {
    const h = harness();
    h.feed(spawnFrame(), 'host-a');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.hostId).toBe('host-b');
    expect(h.sent[0]!.event).toMatchObject({ type: 'patch.spawn', requestId: 'req-1' });
    h.dispose();
  });

  it('routes a SUCCESS response back to the host that asked, not the target', () => {
    const h = harness();
    h.feed(spawnFrame(), 'host-a');
    h.sent.length = 0;
    h.feed(
      {
        type: 'patch.spawn.response',
        requestId: 'req-1',
        sourceChatId: 'chat-src',
        hostId: 'host-b',
        folder: '/work/qa',
        ok: true,
        chatId: 'chat-new',
      } as WireEvent,
      'host-b',
    );
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.hostId).toBe('host-a');
    expect(h.sent[0]!.event).toMatchObject({
      type: 'patch.spawn.response',
      ok: true,
      chatId: 'chat-new',
      hostId: 'host-b',
    });
    h.dispose();
  });

  it('routes a REFUSAL response back — the live defect: this used to reach nobody', () => {
    const h = harness();
    h.feed(spawnFrame(), 'host-a');
    h.sent.length = 0;
    h.feed(
      {
        type: 'patch.spawn.response',
        requestId: 'req-1',
        sourceChatId: 'chat-src',
        hostId: 'host-b',
        folder: '/work/qa',
        ok: false,
        error: {
          code: 'no_model_catalogue',
          message: 'host host-b has never read a model catalogue',
        },
      } as WireEvent,
      'host-b',
    );
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.hostId).toBe('host-a');
    expect(h.sent[0]!.event).toMatchObject({
      type: 'patch.spawn.response',
      ok: false,
      error: { code: 'no_model_catalogue' },
    });
    h.dispose();
  });

  it('drops (loudly) a response for a spawn it never relayed', () => {
    const h = harness();
    h.feed(
      {
        type: 'patch.spawn.response',
        requestId: 'never-seen',
        sourceChatId: 'chat-src',
        hostId: 'host-b',
        folder: '/work/qa',
        ok: true,
        chatId: 'c9',
      } as WireEvent,
      'host-b',
    );
    expect(h.sent).toHaveLength(0);
    h.dispose();
  });

  it('answers an UNREGISTERED target with a refusal response as well as chat.error', () => {
    const h = harness({ registered: ['host-a'] });
    h.feed(spawnFrame({ hostId: 'host-zzz' }), 'host-a');
    const types = h.sent.map((s) => s.event.type);
    expect(types).toEqual(['chat.error', 'patch.spawn.response']);
    expect(h.sent.every((s) => s.hostId === 'host-a')).toBe(true);
    expect(h.sent[1]!.event).toMatchObject({
      ok: false,
      hostId: 'host-zzz',
      error: { code: 'host_not_registered' },
    });
    expect((h.sent[1]!.event as { error: { message: string } }).error.message).toContain(
      'host-zzz',
    );
    h.dispose();
  });

  it('answers an OFFLINE target with a refusal response naming the host', () => {
    const h = harness({ online: ['host-a'] });
    h.feed(spawnFrame(), 'host-a');
    const resp = h.sent.find((s) => s.event.type === 'patch.spawn.response');
    expect(resp?.hostId).toBe('host-a');
    expect((resp?.event as { error: { message: string } }).error.message).toContain('host-b');
    h.dispose();
  });

  it('does not relay a spawn naming the host that raised it (audit frame)', () => {
    const h = harness();
    h.feed(spawnFrame({ hostId: 'host-a', requestId: undefined }), 'host-a');
    expect(h.sent).toHaveLength(0);
    h.dispose();
  });

  it('forgets a relayed spawn once its TTL expires', () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.feed(spawnFrame(), 'host-a');
      h.sent.length = 0;
      vi.advanceTimersByTime(60_001);
      h.feed(
        {
          type: 'patch.spawn.response',
          requestId: 'req-1',
          sourceChatId: 'chat-src',
          hostId: 'host-b',
          folder: '/work/qa',
          ok: true,
          chatId: 'chat-new',
        } as WireEvent,
        'host-b',
      );
      expect(h.sent).toHaveLength(0);
      h.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
