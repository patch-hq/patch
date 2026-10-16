// A snoozed chat is silent on every channel (spec/09 § Snoozed chats), end to
// end through the real assembled server: the frames a host emits for a chat
// that is snoozed produce no push, no desktop notification, no bell entry and
// no ring, and the snooze itself is left alone. The control case — the same
// frames for a chat that is not snoozed — proves the harness would hear them.

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WireEvent } from '@patch/wire';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { Registry } from '../src/registry.js';
import type { PushBackend } from '../src/notifications/router.js';
import { InProcessHostLink } from '../src/host-link.js';
import { buildAll } from '../src/app.js';

const ACCOUNT = generateUserKeypair(() => new Uint8Array(32).fill(7));
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'patch-snooze-silent-'));
  const registry = Registry.load(dir);
  registry.bootstrapAccount({ keypair: ACCOUNT });
  registry.upsertSurface({
    surfaceId: 'srf-t',
    surfaceKind: 'terminal',
    label: 'cli',
    issuedAt: 1,
  });
  registry.registerPushToken({
    surfaceId: 'srf-phone',
    accountId: ACCOUNT.publicKey,
    token: 'fcm-phone-token',
    registeredAt: 1,
  });
  const jwt = await mintSurfaceCredential({
    userPrivateKey: ACCOUNT.privateKey,
    surfaceId: 'srf-t',
    surfaceKind: 'terminal',
    label: 'cli',
  });
  const link = new InProcessHostLink();
  const sent: unknown[] = [];
  const pushBackend: PushBackend = {
    send: async (tokens, payload) => {
      sent.push(payload);
      return { delivered: tokens.length, failed: [], permanentlyRejected: [] };
    },
  };
  const built = await buildAll({ logger: false, registry, hostLink: link, pushBackend });
  const auth = { authorization: `Bearer ${jwt}` };
  return { built, link, sent, auth };
}

const spawned = (chatId: string): WireEvent =>
  ({ type: 'chat.spawned', chatId, hostId: 'd1', folder: '/p', seq: 1, ts: 0 }) as WireEvent;

const state = (chatId: string, over: Record<string, unknown>): WireEvent =>
  ({
    type: 'chat.state',
    chatId,
    hostId: 'd1',
    activity: 'idle',
    permissionMode: 'auto',
    folder: '/p',
    lastUpdated: 0,
    seq: 2,
    ts: 0,
    name: 'nightly build',
    turnOrigin: 'user',
    ...over,
  }) as WireEvent;

/** Every way a chat can try to reach Tom, in the order a host emits them. */
function everything(link: InProcessHostLink, chatId: string, over: Record<string, unknown>): void {
  // Permission block.
  link.emit(state(chatId, { activity: 'running', ...over }));
  link.emit({
    type: 'chat.permission_request',
    chatId,
    requestId: `req-${chatId}`,
    request: { args: {}, tool: 'Bash', description: 'Run: git push' },
    seq: 3,
    ts: 0,
  } as WireEvent);
  link.emit(state(chatId, { activity: 'awaiting-permission', ...over }));
  // Finish.
  link.emit(state(chatId, { activity: 'running', ...over }));
  link.emit(state(chatId, { activity: 'idle', turnSummary: 'all done', ...over }));
  // Error.
  link.emit(state(chatId, { activity: 'running', ...over }));
  link.emit(
    state(chatId, {
      activity: 'errored',
      turnRetrying: false,
      lastError: { code: 'unknown', message: 'API Error: 500', at: 1 },
      ...over,
    }),
  );
  // patch_notify at every level, patch_ask_human, patch_report.
  for (const priority of ['silent', 'normal', 'urgent'] as const) {
    for (const channel of ['push', 'desktop'] as const) {
      link.emit({ type: 'notify', chatId, channel, priority, message: `n-${priority}` });
    }
  }
  link.emit({ type: 'notify', chatId, channel: 'push', kind: 'ask', message: 'needs you' });
  link.emit({ type: 'notify', chatId, kind: 'report', message: 'report' });
  // patch_call.
  link.emit({ type: 'patch.call', chatId, message: 'ring ring' } as WireEvent);
}

describe('snoozed chats are silent, end to end', () => {
  it('control: the same frames for a chat that is NOT snoozed do notify', async () => {
    const { built, link, sent, auth } = await harness();
    try {
      link.emit(spawned('c0'));
      everything(link, 'c0', {});
      await settle();
      expect(sent.length).toBeGreaterThan(0);
      const bell = await built.app.inject({
        method: 'GET',
        url: '/api/notifications',
        headers: auth,
      });
      expect(bell.json().items.length).toBeGreaterThan(0);
    } finally {
      await built.app.close();
    }
  });

  it('a snoozed chat that blocks, finishes, errors, notifies and calls sends nothing, and stays snoozed', async () => {
    const { built, link, sent, auth } = await harness();
    try {
      const until = Date.now() + 3_600_000;
      link.emit(spawned('c1'));
      everything(link, 'c1', { snoozedUntil: until });
      await settle();

      expect(sent).toEqual([]);
      const bell = await built.app.inject({
        method: 'GET',
        url: '/api/notifications',
        headers: auth,
      });
      expect(bell.json()).toMatchObject({ items: [], unread: 0 });
      const chat = await built.app.inject({ method: 'GET', url: '/api/chats/c1', headers: auth });
      expect(chat.json().snoozedUntil).toBe(until);
    } finally {
      await built.app.close();
    }
  });

  it('a snooze that has lapsed is audible again', async () => {
    const { built, link, sent } = await harness();
    try {
      link.emit(spawned('c1'));
      link.emit(state('c1', { activity: 'running', snoozedUntil: Date.now() - 1000 }));
      link.emit({ type: 'notify', chatId: 'c1', channel: 'push', kind: 'ask', message: 'hi' });
      await settle();
      expect(sent.length).toBe(1);
    } finally {
      await built.app.close();
    }
  });

  it('mirrors the snooze records from chat.state', async () => {
    const { built, link } = await harness();
    try {
      const rec = {
        setId: 's1',
        startedAt: 1,
        startSeq: 4,
        until: Date.now() + 1000,
        endedAt: null,
        outcome: { kind: 'none' },
        backCleared: false,
      };
      link.emit(spawned('c1'));
      link.emit(state('c1', { snoozeRecords: [rec], snoozedUntil: rec.until }));
      await settle();
      expect(built.chatRegistry.get('c1')?.snoozeRecords).toEqual([rec]);
    } finally {
      await built.app.close();
    }
  });
});
