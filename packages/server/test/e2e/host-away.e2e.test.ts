// spec/12 § Chat status, end to end: a REAL host goes away and comes back. Every
// chat of it reads Host offline while it is gone, idle ones included; back, each
// reads what its own facts say: an idle chat idle, a running one running until
// its turn ends.

import { describe, it, expect, afterEach } from 'vitest';
import type { WireEvent } from '@patch/wire';
import { startHarness, expectReply, record, until, type E2EHarness } from './harness.js';

let h: E2EHarness | undefined;
afterEach(async () => {
  if (h) await h.close();
  h = undefined;
});

/** The run of distinct statuses a surface was sent for one chat. */
function statuses(events: WireEvent[], chatId: string): string[] {
  return events
    .filter((e) => e.type === 'chat.state' && e.chatId === chatId)
    .map((e) => (e.type === 'chat.state' ? (e.chatStatus?.state ?? '?') : '?'))
    .filter((st, i, all) => i === 0 || all[i - 1] !== st);
}

async function spawn(harness: E2EHarness, jwt: string): Promise<string> {
  const res = await harness.built.app.inject({
    method: 'POST',
    url: '/api/chats',
    headers: { authorization: `Bearer ${jwt}` },
    payload: { hostId: harness.hostId, folder: harness.folder },
  });
  expect(res.statusCode).toBe(202);
  return (res.json() as { chatId: string }).chatId;
}

describe('e2e: a host going away and coming back', () => {
  it('an idle chat reads Host offline while the host is gone, and idle when it is back', async () => {
    // A slow redial keeps the host away long enough to be seen gone.
    h = await startHarness({ hostBackoffMs: [600, 600] });
    const jwt = await h.mintSurface('srf-away-idle');
    const client = await h.connectSurface('srf-away-idle-ws');
    const chatId = await spawn(h, jwt);
    client.send({ type: 'chat.focus_change', chatId });
    client.sendInput({ chatId, message: 'hello', localId: 'L1' });
    await expectReply(client, chatId, 'first turn');
    const states = record(client, ['chat.state']);
    const last = (): string | undefined => statuses(states, chatId).at(-1);
    await until(
      () => h!.built.chatRegistry.get(chatId)?.chatStatus?.state === 'idle',
      3000,
      'idle',
    );
    // Let the server acknowledge the turn's frames, so the host has nothing of
    // it to resend when it redials.
    await new Promise((r) => setTimeout(r, 400));

    expect(h.dropHostLink()).toBe(true);
    await until(() => last() === 'host_offline', 3000, 'idle chat reads host offline');
    expect(h.built.chatRegistry.get(chatId)?.chatStatus?.state).toBe('host_offline');

    await h.waitHostOnline(5000);
    await until(() => last() === 'idle', 3000, 'idle again once the host is back');
    expect(statuses(states, chatId)).toEqual(['host_offline', 'idle']);
    await client.close();
  }, 30_000);

  it('a running chat reads Host offline while the host is gone, running when it is back, and idle when its turn ends', async () => {
    h = await startHarness({ hostBackoffMs: [600, 600], turnDelayMs: 2500 });
    const jwt = await h.mintSurface('srf-away-busy');
    const client = await h.connectSurface('srf-away-busy-ws');
    const chatId = await spawn(h, jwt);
    client.send({ type: 'chat.focus_change', chatId });
    const states = record(client, ['chat.state']);
    const last = (): string | undefined => statuses(states, chatId).at(-1);
    client.sendInput({ chatId, message: 'a long one', localId: 'L1' });
    await until(() => last() === 'running', 3000, 'running');

    expect(h.dropHostLink()).toBe(true);
    await until(() => last() === 'host_offline', 3000, 'running chat reads host offline');

    await h.waitHostOnline(5000);
    await until(() => last() === 'running', 3000, 'running again: the turn carried on');
    await until(() => last() === 'idle', 8000, 'idle when the turn ends');
    const seen = statuses(states, chatId);
    expect(seen.slice(seen.indexOf('running'))).toEqual([
      'running',
      'host_offline',
      'running',
      'idle',
    ]);
    await client.close();
  }, 30_000);
});
