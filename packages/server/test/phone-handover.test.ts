// spec/09 § Handing over to the phone — the state machine on its own, and the
// push it sends through the real router.

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { NotifyEvent } from '@patch/wire';
import { generateUserKeypair } from '@patch/auth';
import { Registry } from '../src/registry.js';
import { PresenceTracker } from '../src/presence.js';
import { NotificationRouter, type PushPayload } from '../src/notifications/router.js';
import {
  HANDOVER_WINDOW_MS,
  PhoneHandover,
  type HandoverChat,
  type HandoverEntry,
} from '../src/notifications/handover.js';

const silent = pino({ level: 'silent' });
const ACCOUNT = generateUserKeypair(() => new Uint8Array(32).fill(9));
const ACC = ACCOUNT.publicKey;

const note = (chatId: string, message = `${chatId} finished`): NotifyEvent => ({
  type: 'notify',
  chatId,
  channel: 'desktop',
  message,
});

function setup(chats: Record<string, HandoverChat | undefined> = {}) {
  let now = 1_000_000;
  const presence = new PresenceTracker();
  presence.online(ACC, 'mac', 'desktop', now);
  const sent: { entries: HandoverEntry[]; names: string[] }[] = [];
  const handover = new PhoneHandover({
    logger: silent,
    presence,
    accountId: () => ACC,
    chat: (id) => (id in chats ? chats[id] : { name: `chat ${id}`, live: true }),
    send: async (entries, names) => {
      sent.push({ entries, names });
    },
    nowMs: () => now,
  });
  /** The Mac reports in, `away` or idle as given, at the current time. */
  const report = (idleMs: number, away?: 'locked' | 'asleep') =>
    presence.input(ACC, 'mac', idleMs, now, { scope: 'system', ...(away ? { away } : {}) });
  return {
    presence,
    handover,
    sent,
    report,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('PhoneHandover', () => {
  it('hands over what was routed to the desktop the moment the screen locks', async () => {
    const t = setup();
    t.report(0);
    await t.handover.check();
    t.handover.record(note('c1'));
    t.report(0, 'locked');
    await t.handover.check();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.entries.map((e) => e.event.chatId)).toEqual(['c1']);
  });

  it('hands over when the user goes idle past the threshold', async () => {
    const t = setup();
    t.report(0);
    await t.handover.check();
    t.handover.record(note('c1'));
    t.advance(30_000);
    t.report(30_000);
    await t.handover.check();
    expect(t.sent).toHaveLength(0);
    t.advance(30_000);
    t.report(60_000);
    await t.handover.check();
    expect(t.sent).toHaveLength(1);
  });

  it('hands over when the computer stops reporting', async () => {
    const t = setup();
    t.report(0);
    await t.handover.check();
    t.handover.record(note('c1'));
    t.advance(46_000);
    await t.handover.check();
    expect(t.sent).toHaveLength(1);
  });

  it('sends nothing when nothing was shown on the desktop', async () => {
    const t = setup();
    t.report(0);
    await t.handover.check();
    t.report(0, 'asleep');
    await t.handover.check();
    expect(t.sent).toHaveLength(0);
  });

  it('only a true → false change hands over: staying away does not, and neither does a restart that never saw the user active', async () => {
    const t = setup();
    t.handover.record(note('c1'));
    t.report(0, 'locked');
    await t.handover.check(); // never saw active
    await t.handover.check();
    expect(t.sent).toHaveLength(0);
  });

  it('a notification is handed over at most once', async () => {
    const t = setup();
    t.report(0);
    await t.handover.check();
    t.handover.record(note('c1'));
    t.report(0, 'locked');
    await t.handover.check();
    t.report(0); // back
    await t.handover.check();
    t.report(0, 'locked'); // and away again
    await t.handover.check();
    expect(t.sent).toHaveLength(1);
  });

  it('skips a notification the user opened', async () => {
    const t = setup();
    t.report(0);
    await t.handover.check();
    t.handover.record(note('c1'));
    t.handover.record(note('c2'));
    t.advance(1000);
    t.handover.opened('c1');
    t.report(0, 'locked');
    await t.handover.check();
    expect(t.sent[0]!.entries.map((e) => e.event.chatId)).toEqual(['c2']);
  });

  it('a notification sent after the chat was opened is still handed over', async () => {
    const t = setup();
    t.report(0);
    await t.handover.check();
    t.handover.opened('c1');
    t.advance(1000);
    t.handover.record(note('c1'));
    t.report(0, 'locked');
    await t.handover.check();
    expect(t.sent).toHaveLength(1);
  });

  it('skips chats that are snoozed, archived or deleted since', async () => {
    const t = setup({
      snoozed: { name: 's', live: false },
      archived: { name: 'a', live: false },
      deleted: undefined,
      fine: { name: 'Fine', live: true },
    });
    t.report(0);
    await t.handover.check();
    for (const id of ['snoozed', 'archived', 'deleted', 'fine']) t.handover.record(note(id));
    t.report(0, 'locked');
    await t.handover.check();
    expect(t.sent[0]!.entries.map((e) => e.event.chatId)).toEqual(['fine']);
    expect(t.sent[0]!.names).toEqual(['Fine']);
  });

  it('sends nothing when every chat has gone', async () => {
    const t = setup({ gone: undefined });
    t.report(0);
    await t.handover.check();
    t.handover.record(note('gone'));
    t.report(0, 'locked');
    await t.handover.check();
    expect(t.sent).toHaveLength(0);
  });

  it('forgets notifications older than ten minutes', async () => {
    const t = setup();
    t.report(0);
    await t.handover.check();
    t.handover.record(note('old'));
    t.advance(HANDOVER_WINDOW_MS + 1);
    t.report(0);
    await t.handover.check();
    t.handover.record(note('new'));
    t.report(0, 'locked');
    await t.handover.check();
    expect(t.sent[0]!.entries.map((e) => e.event.chatId)).toEqual(['new']);
  });

  it('names each chat once', async () => {
    const t = setup();
    t.report(0);
    await t.handover.check();
    t.handover.record(note('c1'));
    t.handover.record(note('c1', 'again'));
    t.handover.record(note('c2'));
    t.report(0, 'locked');
    await t.handover.check();
    expect(t.sent[0]!.entries).toHaveLength(3);
    expect(t.sent[0]!.names).toEqual(['chat c1', 'chat c2']);
  });

  it('does nothing without an account', async () => {
    const send = vi.fn();
    const h = new PhoneHandover({
      logger: silent,
      presence: new PresenceTracker(),
      accountId: () => undefined,
      chat: () => undefined,
      send,
    });
    await h.check();
    expect(send).not.toHaveBeenCalled();
  });

  it('the ticker catches an idle user without any report arriving', async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000_000;
      const presence = new PresenceTracker();
      presence.online(ACC, 'mac', 'desktop', now);
      presence.input(ACC, 'mac', 0, now, { scope: 'system' });
      const send = vi.fn(async () => undefined);
      const h = new PhoneHandover({
        logger: silent,
        presence,
        accountId: () => ACC,
        chat: () => ({ name: 'x', live: true }),
        send,
        nowMs: () => now,
      });
      h.start();
      await vi.advanceTimersByTimeAsync(5000); // sees active
      h.record(note('c1'));
      now += 46_000; // the report goes stale
      await vi.advanceTimersByTimeAsync(5000);
      expect(send).toHaveBeenCalledTimes(1);
      h.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('NotificationRouter.handOver', () => {
  function router(opts: { phoneForeground?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'patch-handover-'));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: ACCOUNT });
    registry.registerPushToken({ surfaceId: 'p', accountId: ACC, token: 'tok', registeredAt: 1 });
    const presence = new PresenceTracker();
    if (opts.phoneForeground) {
      presence.online(ACC, 'phone', 'mobile', 1_000_000);
    }
    const pushes: PushPayload[] = [];
    const infos: { obj: Record<string, unknown>; msg: string }[] = [];
    const logger = pino(
      { level: 'info' },
      { write: (line: string) => infos.push({ obj: JSON.parse(line), msg: JSON.parse(line).msg }) },
    );
    const r = new NotificationRouter({
      logger,
      registry,
      presence,
      wsHub: {} as never,
      dataDir: dir,
      pushBackend: {
        send: async (tokens, payload) => {
          pushes.push(payload);
          return { delivered: tokens.length, failed: [], permanentlyRejected: [] };
        },
      },
      nowMs: () => 1_000_000,
    });
    return { r, pushes, infos, dir, presence };
  }

  it('one notification goes out as the push it would have been', async () => {
    const { r, pushes } = router();
    await r.handOver(
      [
        {
          event: {
            ...note('c1', 'bed planner finished: planted the beds'),
            actions: { kind: 'message' },
          },
        },
      ],
      ['bed planner'],
    );
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.body).toBe('bed planner finished: planted the beds');
    expect(pushes[0]!.data).toMatchObject({ chatId: 'c1' });
    expect(pushes[0]!.data?.['kind']).toBeUndefined();
  });

  it('several go out as one push, counting and naming the chats, opening the chat list', async () => {
    const { r, pushes } = router();
    await r.handOver(
      [{ event: note('c1') }, { event: note('c2') }, { event: note('c3') }],
      ['bed planner', 'forage', 'patch'],
    );
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.body).toBe('3 notifications while you were away: bed planner, forage, patch');
    expect(pushes[0]!.data).toEqual({ kind: 'handover' });
  });

  it('is held back by the Patch app being open on the phone', async () => {
    const { r, pushes, infos } = router({ phoneForeground: true });
    await r.handOver([{ event: note('c1') }, { event: note('c2') }], ['a', 'b']);
    expect(pushes).toHaveLength(0);
    expect(infos.some((i) => i.msg.startsWith('push suppressed'))).toBe(true);
  });

  it('a handover with nothing in it sends nothing', async () => {
    const { r, pushes } = router();
    await r.handOver([], []);
    expect(pushes).toHaveLength(0);
  });

  it('with no push tokens the handover is logged undelivered like any push', async () => {
    const { dir } = router();
    const registry = Registry.load(dir);
    registry.removePushTokens(['tok']);
    const r2 = new NotificationRouter({
      logger: silent,
      registry,
      presence: new PresenceTracker(),
      wsHub: {} as never,
      dataDir: dir,
      pushBackend: { send: async () => ({ delivered: 0, failed: [], permanentlyRejected: [] }) },
    });
    await r2.handOver([{ event: note('c1') }, { event: note('c2') }], ['a', 'b']);
    const { readFileSync } = await import('node:fs');
    const line = JSON.parse(readFileSync(join(dir, 'undelivered.jsonl'), 'utf8').trim());
    expect(line.error).toBe('no push tokens registered');
    expect(line.message).toMatch(/^2 notifications while you were away/);
  });

  it('logs every routing decision with the evidence it rested on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-route-log-'));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: ACCOUNT });
    const presence = new PresenceTracker();
    presence.online(ACC, 'mac', 'desktop', 1_000_000);
    presence.input(ACC, 'mac', 0, 1_000_000, { scope: 'system', away: 'locked' });
    const infos: Record<string, unknown>[] = [];
    const logger = pino(
      { level: 'info' },
      { write: (line: string) => infos.push(JSON.parse(line)) },
    );
    const sendToKind = vi.fn(() => 0);
    const r = new NotificationRouter({
      logger,
      registry,
      presence,
      wsHub: { sendToKind } as never,
      dataDir: dir,
      pushBackend: { send: async () => ({ delivered: 1, failed: [], permanentlyRejected: [] }) },
      nowMs: () => 1_000_000,
    });
    registry.registerPushToken({ surfaceId: 'p', accountId: ACC, token: 'tok', registeredAt: 1 });
    await r.route({ type: 'notify', chatId: 'c1', message: 'hi' });
    const decision = infos.find((l) => l['msg'] === 'notify routed by presence');
    expect(decision).toMatchObject({
      channel: 'push',
      computers: [{ surfaceId: 'mac', state: 'away', away: 'locked' }],
    });
  });

  it('records a desktop-routed notification for handover, but not a call or a silent aside', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-record-'));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: ACCOUNT });
    const seen: NotifyEvent[] = [];
    const r = new NotificationRouter({
      logger: silent,
      registry,
      presence: new PresenceTracker(),
      wsHub: { sendToKind: () => 1 } as never,
      dataDir: dir,
      onDesktopRouted: (e) => seen.push(e),
    });
    await r.route(note('c1'));
    await r.route({ ...note('c2'), kind: 'call' });
    await r.route({ ...note('c3'), priority: 'silent' });
    expect(seen.map((e) => e.chatId)).toEqual(['c1']);
  });

  it('does not record a desktop notification that reached no desktop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patch-record0-'));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: ACCOUNT });
    const seen: NotifyEvent[] = [];
    const r = new NotificationRouter({
      logger: silent,
      registry,
      presence: new PresenceTracker(),
      wsHub: { sendToKind: () => 0 } as never,
      dataDir: dir,
      onDesktopRouted: (e) => seen.push(e),
    });
    await r.route(note('c1'));
    expect(seen).toEqual([]);
  });
});
