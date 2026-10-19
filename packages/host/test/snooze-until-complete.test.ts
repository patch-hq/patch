// "Snooze → Until complete" (spec/04 § Snooze): the chat leaves the list and
// comes back on its own once its work is done — turn returned and no goal left.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { SNOOZE_UNTIL_COMPLETE } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import type { SdkBackend } from '../src/sdkBackend.js';

const T0 = 1_700_000_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gated() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const backend: SdkBackend = {
    run: async function* () {
      await gate;
      yield { type: 'assistant', content: 'ok', sessionId: 's' };
      yield { type: 'result', sessionId: 's' };
    },
  };
  return { backend, release };
}

function setup(backend: SdkBackend, home?: string) {
  const h = home ?? mkdtempSync(join(tmpdir(), 'patch-snzc-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-snzc-f-')));
  mkdirSync(folder, { recursive: true });
  const metaStore = createMetaStore(h);
  let id = 0;
  const daemon = new Daemon({
    hostId: 'd1',
    metaStore,
    sdkBackend: backend,
    oauthAccessToken: 'x',
    emit: () => {},
    logger: pino({ level: 'silent' }),
    now: () => T0,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, folder, metaStore, home: h };
}

describe('Snooze until complete', () => {
  it('stays snoozed while the turn runs and wakes when it returns', async () => {
    const { backend, release } = gated();
    const { daemon, folder, metaStore } = setup(backend);
    const id = await daemon.spawnChat({ folder });
    const turn = daemon.sendInput({ chatId: id, message: 'go', localId: 'L1', origin: 'user' });
    await sleep(20);
    await daemon.setSnoozed(id, SNOOZE_UNTIL_COMPLETE);
    await sleep(40);
    expect(daemon.chatState.get(id)?.snoozedUntil).toBe(SNOOZE_UNTIL_COMPLETE);
    expect(daemon.listWithFilter().some((c) => c.chatId === id)).toBe(false);

    release();
    await turn;
    await sleep(80);
    expect(daemon.chatState.get(id)?.snoozedUntil).toBe(null);
    expect(metaStore.read(id)?.snoozedUntil).toBe(null);
    expect(daemon.listWithFilter().some((c) => c.chatId === id)).toBe(true);
    const rec = daemon.chatState.get(id)!.snoozeRecords.at(-1)!;
    expect(rec.outcome.kind).toBe('finished');
    expect(rec.endedAt).not.toBe(null);
    daemon.shutdown();
  });

  it('stays snoozed after a turn returns while a goal is still open, wakes when it clears', async () => {
    const { backend, release } = gated();
    const { daemon, folder } = setup(backend);
    const id = await daemon.spawnChat({ folder });
    await daemon.setGoal(id, 'ship it');
    await daemon.setSnoozed(id, SNOOZE_UNTIL_COMPLETE);
    expect(daemon.chatState.get(id)?.snoozedUntil).toBe(SNOOZE_UNTIL_COMPLETE);
    release();
    await daemon.sendInput({ chatId: id, message: 'go', localId: 'L1', origin: 'user' });
    await sleep(80);
    expect(daemon.chatState.get(id)?.snoozedUntil).toBe(SNOOZE_UNTIL_COMPLETE);
    await daemon.setGoal(id, null);
    expect(daemon.chatState.get(id)?.snoozedUntil).toBe(null);
    daemon.shutdown();
  });

  it('refuses a chat with nothing running and no goal', async () => {
    const { backend } = gated();
    const { daemon, folder } = setup(backend);
    const id = await daemon.spawnChat({ folder });
    await expect(daemon.setSnoozed(id, SNOOZE_UNTIL_COMPLETE)).rejects.toThrow(/no running work/);
    expect(daemon.chatState.get(id)?.snoozedUntil).toBe(null);
    daemon.shutdown();
  });

  it('a host restart wakes it: the run it waited on is gone', async () => {
    const { backend } = gated();
    const first = setup(backend);
    const id = await first.daemon.spawnChat({ folder: first.folder });
    await first.daemon.setGoal(id, 'ship it');
    await first.daemon.setSnoozed(id, SNOOZE_UNTIL_COMPLETE);
    first.daemon.shutdown();
    const second = setup(backend, first.home);
    second.daemon.hydrate();
    expect(second.daemon.chatState.get(id)?.snoozedUntil ?? null).toBe(null);
    second.daemon.shutdown();
  });
});
