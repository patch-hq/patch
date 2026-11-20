// spec/11 § Replacing a host, end to end: a REAL server and two REAL hosts over
// REAL WebSockets. Host A has chats and a message held for it while it is
// away; B replaces A; the held message runs on B, and a new turn on a moved
// chat lands on B numbered straight on from the server's record.

import { describe, it, expect, afterEach } from 'vitest';
import type { WireEvent } from '@patch/wire';
import { startHarness, expectReply, until, type E2EHarness } from './harness.js';

let h: E2EHarness | undefined;
afterEach(async () => {
  if (h) await h.close();
  h = undefined;
});

const seqOf = (e: WireEvent): number => (e as { seq: number }).seq;

describe('e2e: replacing a host', () => {
  it('chats and a held message on A move to B; new turns land on B at the right seq', async () => {
    // The primary host (B) is the Manager's home; A is the one replaced.
    h = await startHarness({ hostBackoffMs: [50, 50] });
    const b = h.hostId;
    const a = await h.addHost('daemon-e2e-a');
    const jwt = await h.mintSurface('srf-replace');
    const client = await h.connectSurface('srf-replace-ws');
    const headers = { authorization: `Bearer ${jwt}` };

    // Two chats on A, one with a turn.
    const spawn = async (): Promise<string> => {
      const res = await h!.built.app.inject({
        method: 'POST',
        url: '/api/chats',
        headers,
        payload: { hostId: a.hostId, folder: h!.folder },
      });
      expect(res.statusCode).toBe(202);
      return (res.json() as { chatId: string }).chatId;
    };
    const chatId = await spawn();
    const quiet = await spawn();
    await until(() => a.daemon.chatState.has(quiet), 3000, 'second chat on A');
    client.send({ type: 'chat.focus_change', chatId });
    client.sendInput({ chatId, message: 'first, on A', localId: 'A1' });
    await expectReply(client, chatId, 'turn on A');
    const log = h.built.chatLogStore;
    await until(() => log.highWater(chatId) >= 1, 3000, 'turn on A recorded');
    // Let A's last frames settle into the record before it goes.
    await new Promise((r) => setTimeout(r, 200));

    // A goes away for good; a message sent now is held for it.
    await a.close();
    await until(() => !h!.built.hostLink.isOnline(a.hostId), 5000, 'A offline');
    const before = log.highWater(chatId);
    client.sendInput({ chatId, message: 'held while A is gone', localId: 'H1' });
    await until(
      () => h!.built.chatRegistry.factsOf(chatId)?.held.length === 1,
      3000,
      'message held for A',
    );

    // The plan: B has the folder (same machine, same path).
    const plan = await h.built.app.inject({
      method: 'GET',
      url: `/api/hosts/${a.hostId}/replace?with=${b}`,
      headers,
    });
    expect(plan.statusCode).toBe(200);
    expect(plan.json()).toMatchObject({ chats: 2, missing: [] });

    // Replace A with B. The held message is handed to B and runs there.
    const replied = expectReply(client, chatId, 'held message on B', 8000);
    const res = await h.built.app.inject({
      method: 'POST',
      url: `/api/hosts/${a.hostId}/replace`,
      headers,
      payload: { with: b },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, moved: 2 });
    expect(h.built.chatRegistry.get(chatId)?.hostId).toBe(b);
    expect(h.built.chatRegistry.get(quiet)?.hostId).toBe(b);
    expect(h.registry.isRegisteredHost(a.hostId)).toBe(false);
    expect(h.daemon.chatState.has(chatId)).toBe(true);
    await replied;

    // A new turn on the moved chat runs on B.
    client.sendInput({ chatId, message: 'after the move', localId: 'B1' });
    await expectReply(client, chatId, 'new turn on B', 8000);
    await until(
      () =>
        log
          .read(chatId, before)
          .some((e) => e.type === 'chat.message' && e.content === 'after the move'),
      3000,
      'the new turn is in the record',
    );

    // Everything B wrote was kept, numbered on from where A left off: no
    // entry refused as clashing, none repeated, in order.
    const fromB = log.read(chatId, before);
    expect(Math.min(...fromB.map(seqOf))).toBe(before + 1);
    const seqs = log.read(chatId, -1).map(seqOf);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
    const said = fromB.flatMap((e) =>
      e.type === 'chat.message' && e.role === 'user' ? [e.content] : [],
    );
    expect(said).toEqual(['held while A is gone', 'after the move']);
    await client.close();
  }, 30_000);
});
