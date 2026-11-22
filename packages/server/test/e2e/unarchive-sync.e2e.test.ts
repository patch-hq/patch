// Unarchiving a chat on one device and chatting in it, seen from every device
// (spec/03 § Account feed, spec/05 § Loading; decisions 26–28). REAL server and
// host; two surfaces, "phone" and "web", that speak the feed as the spec says a
// device does: `feed.resume` on connect with the chats it follows, and
// `feed.follow` whenever that set changes — here, when the unarchived chat comes
// back into its list.

import { describe, it, expect, afterEach } from 'vitest';
import type { WireTestClient } from '@patch/wire/test-client';
import type { WireEvent } from '@patch/wire';
import { startHarness, expectReply, until, type E2EHarness } from './harness.js';

let h: E2EHarness | undefined;
const open: WireTestClient[] = [];
afterEach(async () => {
  for (const c of open.splice(0)) await c.close().catch(() => undefined);
  if (h) await h.close();
  h = undefined;
});

/** A device: what it has been sent, and the chat list it would draw. */
interface Device {
  client: WireTestClient;
  events: WireEvent[];
  /** Chat id → lifecycle status, from every `chat.state` it was sent. */
  list: Map<string, string>;
  feedPos: number | undefined;
}

async function device(
  harness: E2EHarness,
  surfaceId: string,
  follow: string[] = [],
  after?: number,
  held: Array<{ seq: number }> = [],
) {
  const client = await harness.connectSurface(surfaceId);
  open.push(client);
  const d: Device = { client, events: [], list: new Map(), feedPos: after };
  for (const type of ['chat.state', 'chat.message', 'chat.history'] as const) {
    client.on(type, (e) => {
      d.events.push(e as WireEvent);
      if (e.type === 'chat.state') {
        if (e.status !== undefined) d.list.set(e.chatId, e.status);
        const pos = (e as { feedPos?: number }).feedPos;
        if (typeof pos === 'number') d.feedPos = Math.max(d.feedPos ?? -1, pos);
      }
    });
  }
  client.send({
    type: 'feed.resume',
    ...(after !== undefined ? { after } : {}),
    follow: follow.map((chatId) => ({ chatId, after: held.at(-1)?.seq ?? -1 })),
  } as WireEvent);
  return d;
}

/** The chat's messages the device holds, by seq, each once (live and history pages). */
function messagesOf(
  d: Device,
  chatId: string,
): Array<{ seq: number; role: string; content: string }> {
  const bySeq = new Map<number, { seq: number; role: string; content: string }>();
  for (const e of d.events) {
    const entries =
      e.type === 'chat.history' && e.chatId === chatId
        ? (e.entries as WireEvent[])
        : e.type === 'chat.message' && e.chatId === chatId
          ? [e]
          : [];
    for (const x of entries) {
      if (x.type !== 'chat.message' || typeof x.seq !== 'number' || x.seq < 0) continue;
      bySeq.set(x.seq, { seq: x.seq, role: x.role, content: x.content });
    }
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** Live `chat.message` frames for one seq the device was sent (a duplicate shows as 2). */
function liveCount(d: Device, chatId: string, content: string): number {
  return d.events.filter(
    (e) => e.type === 'chat.message' && e.chatId === chatId && e.content === content,
  ).length;
}

/** The seqs of the chat's messages in the server's record. */
function recordSeqs(harness: E2EHarness, chatId: string): number[] {
  return harness.built.chatLogStore
    .read(chatId, -1)
    .filter((e) => e.type === 'chat.message')
    .map((e) => (e as { seq: number }).seq);
}

async function archivedChat(harness: E2EHarness): Promise<string> {
  const jwt = await harness.mintSurface('srf-setup');
  const res = await harness.built.app.inject({
    method: 'POST',
    url: '/api/chats',
    headers: { authorization: `Bearer ${jwt}` },
    payload: { hostId: harness.hostId, folder: harness.folder },
  });
  expect(res.statusCode).toBe(202);
  const chatId = (res.json() as { chatId: string }).chatId;
  const setup = await harness.connectSurface('srf-setup-ws');
  open.push(setup);
  setup.send({ type: 'chat.focus_change', chatId });
  setup.sendInput({ chatId, message: 'before archiving', localId: 'L0' });
  await expectReply(setup, chatId, 'first turn');
  await until(
    () => harness.built.chatRegistry.get(chatId)?.chatStatus?.state === 'idle',
    5000,
    'first turn settled',
  );
  setup.send({ type: 'chat.archive_request', chatId, archived: true } as WireEvent);
  await until(
    () => harness.built.chatRegistry.get(chatId)?.status === 'archived',
    5000,
    'archived',
  );
  return chatId;
}

/** What the spec asks of a device whose list gains a chat: follow it. */
function followWhenListed(d: Device, chatId: string): void {
  let sent = false;
  d.client.on('chat.state', (e) => {
    if (sent || e.chatId !== chatId || e.status !== 'active') return;
    sent = true;
    d.client.send({
      type: 'feed.follow',
      follow: [{ chatId, after: messagesOf(d, chatId).at(-1)?.seq ?? -1 }],
    } as WireEvent);
  });
}

async function unarchiveAndChat(from: Device, others: Device[], chatId: string, text: string) {
  for (const d of [from, ...others]) followWhenListed(d, chatId);
  from.client.send({ type: 'chat.archive_request', chatId, archived: false } as WireEvent);
  for (const d of [from, ...others]) {
    await until(() => d.list.get(chatId) === 'active', 5000, 'chat back in the list');
  }
  // The sender opens it, as a person does to type in it.
  from.client.send({ type: 'chat.focus_change', chatId });
  from.client.sendInput({ chatId, message: text, localId: `L-${text}` });
}

describe('e2e: unarchive a chat on one device and chat in it', () => {
  it('phone unarchives and chats: both devices list it and get the message and reply live, and a reconnect loses or repeats nothing', async () => {
    h = await startHarness();
    const chatId = await archivedChat(h);
    const phone = await device(h, 'srf-phone');
    const web = await device(h, 'srf-web');

    await unarchiveAndChat(phone, [web], chatId, 'back again');
    for (const d of [phone, web]) {
      await until(
        () => messagesOf(d, chatId).some((m) => m.role === 'user' && m.content === 'back again'),
        5000,
        'user message live',
      );
      await until(
        () => messagesOf(d, chatId).some((m) => m.role === 'assistant' && m.seq > 2),
        5000,
        'reply live',
      );
    }
    expect(liveCount(web, chatId, 'back again')).toBe(1);
    // Each device holds the whole chat once it follows it: what came before the
    // archive as well as the new turn. (The phone, which sent the unarchive,
    // was caught up on nothing: its own request had the server watching the
    // chat for it already, so its feed.follow was taken as nothing new.)
    for (const [name, d] of [
      ['web', web],
      ['phone', phone],
    ] as const) {
      expect(
        messagesOf(d, chatId).map((m) => m.seq),
        `${name} holds the whole chat`,
      ).toEqual(recordSeqs(h, chatId));
    }

    // Reconnect each device from what it holds: nothing lost, nothing twice.
    for (const [name, d] of [
      ['srf-web-2', web],
      ['srf-phone-2', phone],
    ] as const) {
      const held = messagesOf(d, chatId);
      await d.client.close();
      const again = await device(h, name, [chatId], d.feedPos, held);
      await new Promise((r) => setTimeout(r, 300));
      // What the new socket was sent for the chat: only entries past what it held.
      const fresh = again.events.filter(
        (e) => (e.type === 'chat.history' || e.type === 'chat.message') && e.chatId === chatId,
      );
      for (const e of fresh) {
        const entries = e.type === 'chat.history' ? (e.entries as WireEvent[]) : [e];
        for (const x of entries) {
          if (x.type === 'chat.message') expect(x.seq).toBeGreaterThan(held.at(-1)!.seq);
        }
      }
      // Nothing lost: what it holds plus what it was sent is the whole record.
      const record = recordSeqs(h, chatId);
      const now = new Set([
        ...held.map((m) => m.seq),
        ...messagesOf(again, chatId).map((m) => m.seq),
      ]);
      expect([...now].sort((a, b) => a - b)).toEqual(record);
    }
  });

  it('web unarchives and chats: the phone lists it and gets the message and reply live', async () => {
    h = await startHarness();
    const chatId = await archivedChat(h);
    const phone = await device(h, 'srf-phone');
    const web = await device(h, 'srf-web');
    await unarchiveAndChat(web, [phone], chatId, 'from the desk');
    await until(
      () => messagesOf(phone, chatId).some((m) => m.content === 'from the desk'),
      5000,
      'phone: user message live',
    );
    await until(
      () => messagesOf(phone, chatId).some((m) => m.role === 'assistant' && m.seq > 2),
      5000,
      'phone: reply live',
    );
    for (const d of [web, phone]) {
      expect(messagesOf(d, chatId).map((m) => m.seq)).toEqual(recordSeqs(h, chatId));
    }
  });

  it('unarchiving a chat whose host is offline: the chat comes back, and the message is held and answered when the host returns', async () => {
    h = await startHarness({ hostBackoffMs: [1500, 1500] });
    const chatId = await archivedChat(h);
    const phone = await device(h, 'srf-phone');
    const web = await device(h, 'srf-web');
    await new Promise((r) => setTimeout(r, 400));
    expect(h.dropHostLink()).toBe(true);
    await h.waitHostOffline(3000);
    await unarchiveAndChat(phone, [web], chatId, 'while away');
    await until(
      () => messagesOf(web, chatId).some((m) => m.role === 'assistant' && m.seq > 2),
      10_000,
      'web: reply once the host is back',
    );
    for (const d of [web, phone]) {
      await until(
        () => messagesOf(d, chatId).length === recordSeqs(h!, chatId).length,
        5000,
        'whole chat held',
      );
      expect(messagesOf(d, chatId).map((m) => m.seq)).toEqual(recordSeqs(h, chatId));
    }
  });
});
