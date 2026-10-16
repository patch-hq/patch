// What happened while a chat was snoozed, and the Back state that says so
// (spec/04 § Snooze → Back): a record per snooze in meta.json, an outcome
// derived from what the chat did, and one clear for a whole set.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';

const T0 = 1_700_000_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const finishing: SdkBackend = {
  run: async function* () {
    yield { type: 'assistant', content: 'ok', sessionId: 's' };
    yield { type: 'result', sessionId: 's' };
  },
};

const failing: SdkBackend = {
  run: async function* () {
    throw new Error('API Error: 500 Internal');
  },
};

function setup(backend: SdkBackend = finishing, home?: string, clockRef?: { t: number }) {
  const h = home ?? mkdtempSync(join(tmpdir(), 'patch-snzb-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-snzb-f-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(h);
  const clock = clockRef ?? { t: T0 };
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore,
    sdkBackend: backend,
    oauthAccessToken: 'x',
    emit: (e) => events.push(e),
    logger: pino({ level: 'silent' }),
    now: () => clock.t,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, folder, metaStore, clock, events, home: h };
}

/** Let the snooze timer fire at `until` on a clock the test owns. */
async function pastWake(clock: { t: number }, until: number): Promise<void> {
  clock.t = until + 1;
  await sleep(until - T0 + 60);
}

const last = (daemon: Daemon, chatId: string) => {
  const r = daemon.chatState.get(chatId)!.snoozeRecords;
  return r[r.length - 1]!;
};

describe('snooze records and outcome', () => {
  it('opens a record on snooze; chats snoozed by one action share a set', async () => {
    const { daemon, folder, metaStore } = setup();
    const a = await daemon.spawnChat({ folder });
    const b = await daemon.spawnChat({ folder });
    await daemon.setSnoozed(a, T0 + 60_000, { setId: 'set-1' });
    await daemon.setSnoozed(b, T0 + 60_000, { setId: 'set-1' });
    expect(last(daemon, a)).toMatchObject({
      setId: 'set-1',
      startedAt: T0,
      until: T0 + 60_000,
      endedAt: null,
      outcome: { kind: 'none' },
      backCleared: false,
    });
    expect(metaStore.read(a)?.snoozeRecords).toHaveLength(1);
    expect(last(daemon, b).setId).toBe('set-1');
    daemon.shutdown();
  });

  it('a chat that did nothing comes back with outcome none', async () => {
    const { daemon, folder, clock } = setup();
    const id = await daemon.spawnChat({ folder });
    await daemon.setSnoozed(id, T0 + 40);
    await pastWake(clock, T0 + 40);
    expect(daemon.chatState.get(id)?.snoozedUntil).toBeNull();
    expect(last(daemon, id)).toMatchObject({
      endedAt: T0 + 40,
      outcome: { kind: 'none' },
      backCleared: false,
    });
    daemon.shutdown();
  });

  it('a turn that finishes during the snooze comes back finished, with its time', async () => {
    const { daemon, folder, clock } = setup();
    const id = await daemon.spawnChat({ folder });
    await daemon.setSnoozed(id, T0 + 400);
    clock.t = T0 + 100;
    await daemon.sendInput({ chatId: id, message: 'go', localId: 'L1', origin: 'user' });
    await sleep(60);
    await pastWake(clock, T0 + 400);
    expect(last(daemon, id).outcome).toEqual({ kind: 'finished', at: T0 + 100 });
    daemon.shutdown();
  });

  it('a turn that fails during the snooze comes back errored', async () => {
    const { daemon, folder, clock } = setup(failing);
    const id = await daemon.spawnChat({ folder });
    await daemon.setSnoozed(id, T0 + 600);
    clock.t = T0 + 100;
    await daemon.sendInput({ chatId: id, message: 'go', localId: 'L1', origin: 'user' });
    await sleep(100);
    expect(daemon.chatState.get(id)?.snoozedUntil).toBe(T0 + 600);
    await pastWake(clock, T0 + 600);
    expect(last(daemon, id).outcome).toMatchObject({ kind: 'errored', at: T0 + 100 });
    daemon.shutdown();
  });

  it('a snoozed chat stays snoozed when it finishes (nothing ends the snooze)', async () => {
    const { daemon, folder, clock } = setup();
    const id = await daemon.spawnChat({ folder });
    await daemon.setSnoozed(id, T0 + 5_000);
    clock.t = T0 + 100;
    await daemon.sendInput({ chatId: id, message: 'go', localId: 'L1', origin: 'user' });
    await sleep(60);
    expect(daemon.chatState.get(id)?.snoozedUntil).toBe(T0 + 5_000);
    daemon.shutdown();
  });

  it('re-snoozing a chat that is still snoozed moves the wake time, not the start', async () => {
    const { daemon, folder, clock } = setup();
    const id = await daemon.spawnChat({ folder });
    await daemon.setSnoozed(id, T0 + 60_000);
    clock.t = T0 + 1000;
    await daemon.setSnoozed(id, T0 + 120_000);
    expect(daemon.chatState.get(id)!.snoozeRecords).toHaveLength(1);
    expect(last(daemon, id)).toMatchObject({ startedAt: T0, until: T0 + 120_000 });
    daemon.shutdown();
  });

  it('records, outcome and times survive a host restart', async () => {
    const first = setup();
    const id = await first.daemon.spawnChat({ folder: first.folder });
    await first.daemon.setSnoozed(id, T0 + 400);
    first.clock.t = T0 + 100;
    await first.daemon.sendInput({ chatId: id, message: 'go', localId: 'L1', origin: 'user' });
    await sleep(60);
    first.daemon.shutdown();

    // Down past the wake time, then back.
    const clock = { t: T0 + 10_000 };
    const second = setup(finishing, first.home, clock);
    second.daemon.hydrate();
    expect(second.daemon.chatState.get(id)?.snoozedUntil).toBeNull();
    expect(last(second.daemon, id)).toMatchObject({
      setId: expect.any(String),
      startedAt: T0,
      endedAt: T0 + 400,
      outcome: { kind: 'finished', at: T0 + 100 },
      backCleared: false,
    });
    expect(second.metaStore.read(id)?.snoozeRecords?.[0]?.outcome.kind).toBe('finished');
    second.daemon.shutdown();
  });

  it('an agent’s patch_send_to ends the snooze and the chat comes back (not cleared)', async () => {
    const { daemon, folder } = setup();
    const id = await daemon.spawnChat({ folder });
    await daemon.setSnoozed(id, T0 + 60_000);
    await daemon.submitInput({
      chatId: id,
      message: 'hi',
      localId: 'L1',
      origin: 'machine',
      fromAgent: true,
    });
    await sleep(40);
    expect(daemon.chatState.get(id)?.snoozedUntil).toBeNull();
    expect(last(daemon, id).endedAt).not.toBeNull();
    expect(last(daemon, id).backCleared).toBe(false);
    daemon.shutdown();
  });

  it('a person unsnoozing leaves nothing to say: no Back state', async () => {
    const { daemon, folder } = setup();
    const id = await daemon.spawnChat({ folder });
    await daemon.setSnoozed(id, T0 + 60_000);
    await daemon.setSnoozed(id, null);
    expect(last(daemon, id)).toMatchObject({ endedAt: T0, backCleared: true });
    daemon.shutdown();
  });
});

describe('clearing the Back state', () => {
  async function twoBack() {
    const s = setup();
    const a = await s.daemon.spawnChat({ folder: s.folder });
    const b = await s.daemon.spawnChat({ folder: s.folder });
    const other = await s.daemon.spawnChat({ folder: s.folder });
    await s.daemon.setSnoozed(a, T0 + 40, { setId: 'set-1' });
    await s.daemon.setSnoozed(b, T0 + 40, { setId: 'set-1' });
    await s.daemon.setSnoozed(other, T0 + 40, { setId: 'set-2' });
    await pastWake(s.clock, T0 + 40);
    return { ...s, a, b, other };
  }

  it('clearing one chat clears its whole set and no other', async () => {
    const { daemon, a, b, other, events, metaStore } = await twoBack();
    events.length = 0;
    daemon.clearSnoozeBack(a);
    expect(last(daemon, a).backCleared).toBe(true);
    expect(last(daemon, b).backCleared).toBe(true);
    expect(last(daemon, other).backCleared).toBe(false);
    expect(metaStore.read(b)?.snoozeRecords?.[0]?.backCleared).toBe(true);
    // Every chat of the set is broadcast so every surface agrees.
    const broadcast = events
      .filter((e) => e.type === 'chat.state')
      .map((e) => (e as { chatId: string }).chatId);
    expect(broadcast).toEqual(expect.arrayContaining([a, b]));
    daemon.shutdown();
  });

  it('sending to a chat that came back clears its set', async () => {
    const { daemon, a, b } = await twoBack();
    await daemon.sendInput({
      chatId: a,
      message: 'hello',
      localId: 'L1',
      origin: 'user',
      fromUser: true,
    });
    expect(last(daemon, b).backCleared).toBe(true);
    daemon.shutdown();
  });

  it('archiving a chat that came back clears its set', async () => {
    const { daemon, a, b } = await twoBack();
    await daemon.setArchived(a, true);
    expect(last(daemon, b).backCleared).toBe(true);
    daemon.shutdown();
  });

  it('snoozing again clears the earlier set and opens a new record; the divider data stays', async () => {
    const { daemon, a, b } = await twoBack();
    await daemon.setSnoozed(a, T0 + 100_000);
    expect(last(daemon, b).backCleared).toBe(true);
    expect(daemon.chatState.get(a)!.snoozeRecords).toHaveLength(2);
    expect(daemon.chatState.get(a)!.snoozeRecords[0]!.backCleared).toBe(true);
    daemon.shutdown();
  });

  it('clearing a chat that is not showing Back does nothing', async () => {
    const { daemon, folder } = setup();
    const id = await daemon.spawnChat({ folder });
    daemon.clearSnoozeBack(id);
    expect(daemon.chatState.get(id)!.snoozeRecords).toEqual([]);
    daemon.shutdown();
  });
});
