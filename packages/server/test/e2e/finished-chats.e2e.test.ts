// End-to-end: a chat that finishes reaches the Manager (spec/06 § Finished
// chats). The server notices the finish, asks the home host to deliver, and
// the host sends one machine turn into the Manager whose notes carry the
// chat's last reply. Unit tests cover each half; this drives the REAL server
// and REAL host over the REAL link, so the event shapes have to agree.

import { describe, it, expect, afterEach } from 'vitest';
import type { WireEvent } from '@patch/wire';
import { startHarness, until, type E2EHarness } from './harness.js';

let h: E2EHarness | undefined;
afterEach(async () => {
  if (h) await h.close();
  h = undefined;
});

async function history(harness: E2EHarness, jwt: string, chatId: string): Promise<WireEvent[]> {
  const res = await harness.built.app.inject({
    method: 'GET',
    url: `/api/chats/${chatId}/history?since=0`,
    headers: { authorization: `Bearer ${jwt}` },
  });
  return res.statusCode === 200 ? (res.json() as { events: WireEvent[] }).events : [];
}

describe('e2e: finished chats → the Manager', () => {
  it('Each one: a finished chat arrives in the Manager as a note and Patch’s line', async () => {
    h = await startHarness({ specialThreads: true });
    const jwt = await h.mintSurface('srf-finished');
    const harness = h;
    await until(
      () => harness.built.chatRegistry.get('thread_manager') !== undefined,
      5000,
      'Manager known to the server',
    );
    const set = await h.built.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { managerWake: 'each' },
    });
    expect(set.statusCode).toBe(200);

    const spawned = await h.built.app.inject({
      method: 'POST',
      url: '/api/chats',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { hostId: h.hostId, folder: h.folder, prompt: 'build the bus tracker' },
    });
    expect(spawned.statusCode).toBe(202);
    const chatId = (spawned.json() as { chatId: string }).chatId;

    let events: WireEvent[] = [];
    await until(
      () => {
        void history(harness, jwt, 'thread_manager').then((e) => (events = e));
        return events.some((e) => e.type === 'chat.note' && e.label.startsWith('Finished · '));
      },
      10_000,
      'the Manager got a Finished note',
    );
    const note = events.find((e) => e.type === 'chat.note' && e.label.startsWith('Finished · '));
    expect(note).toBeDefined();
    expect((note as { text: string }).text).toContain(`Chat: ${chatId}`);
    expect((note as { text: string }).text).toContain(`Link: patch://chats/${chatId}`);
    const line = events.find(
      (e) => e.type === 'chat.message' && e.role === 'user' && / finished\.$/.test(e.content),
    );
    expect(line).toMatchObject({ origin: 'machine' });
  });
});
